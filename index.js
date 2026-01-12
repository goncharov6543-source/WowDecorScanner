const axios = require('axios');
const fs = require('fs');
const pLimit = require('p-limit');

// --- КОНФІГУРАЦІЯ ---
// Беремо ключі з "Сейфу" GitHub (Environment Variables)
const CLIENT_ID = process.env.BLIZZARD_CLIENT_ID;
const CLIENT_SECRET = process.env.BLIZZARD_CLIENT_SECRET;
const REGION = 'eu';

// СПИСОК ID ПРЕДМЕТІВ, ЯКІ МИ ШУКАЄМО (WhiteList)
// Наприклад: 210933 (Weavercloth), 67151 (Poseidus)
const WANTED_ITEMS = new Set([
    257042, 262347, 264705, 258215 // <--- ДОДАЙ СЮДИ СВОЇ ID
]);

// Налаштування
const CONCURRENCY = 20; // Кількість потоків
const api = axios.create({ timeout: 20000 });

async function getAccessToken() {
    console.log("🔑 Отримую токен...");
    const auth = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64');
    const res = await api.post('https://oauth.battle.net/token', 'grant_type=client_credentials', {
        headers: { 'Authorization': `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' }
    });
    return res.data.access_token;
}

async function getRealms(token) {
    console.log("🌍 Отримую список серверів...");
    const res = await api.get(`https://${REGION}.api.blizzard.com/data/wow/connected-realm/index?namespace=dynamic-${REGION}&locale=en_GB`, {
        headers: { Authorization: `Bearer ${token}` }
    });
    return res.data.connected_realms.map(link => {
        const parts = link.href.split('/');
        return parseInt(parts[parts.length - 1].split('?')[0]);
    });
}

async function getRealmName(id, token) {
    try {
        const res = await api.get(`https://${REGION}.api.blizzard.com/data/wow/connected-realm/${id}?namespace=dynamic-${REGION}&locale=en_GB`, {
            headers: { Authorization: `Bearer ${token}` }
        });
        return res.data.realms[0].name; // Беремо першу назву
    } catch (e) { return `Realm-${id}`; }
}

async function scanServer(realmId, realmName, token, resultsArray) {
    try {
        const url = `https://${REGION}.api.blizzard.com/data/wow/connected-realm/${realmId}/auctions?namespace=dynamic-${REGION}&locale=en_GB`;
        const res = await api.get(url, { headers: { Authorization: `Bearer ${token}` } });
        
        // Фільтрація
        res.data.auctions.forEach(lot => {
            if (WANTED_ITEMS.has(lot.item.id)) {
                const price = (lot.buyout || lot.unit_price) / 10000;
                resultsArray.push({
                    realm: realmName,
                    id: lot.item.id,
                    price: price,
                    qty: lot.quantity
                });
            }
        });
    } catch (e) { /* Ігноруємо помилки серверів */ }
}

async function generateHTML(data) {
    console.log("📝 Генерую звіт...");
    const rows = data.sort((a,b) => a.price - b.price).map(item => `
        <tr>
            <td>${item.id}</td>
            <td>${item.realm}</td>
            <td style="color:gold; font-weight:bold">${item.price.toLocaleString()} g</td>
            <td>${item.qty}</td>
        </tr>
    `).join('');

    const html = `
    <!DOCTYPE html>
    <html>
    <head>
        <meta charset="UTF-8">
        <title>WoW Prices Report</title>
        <style>
            body { background: #222; color: #fff; font-family: sans-serif; padding: 20px; }
            table { width: 100%; border-collapse: collapse; background: #333; }
            th, td { padding: 10px; border: 1px solid #444; text-align: left; }
            th { background: #444; }
        </style>
    </head>
    <body>
        <h1>📊 Звіт по цінах (EU)</h1>
        <p>Оновлено: ${new Date().toLocaleString()}</p>
        <table>
            <tr><th>Item ID</th><th>Сервер</th><th>Ціна</th><th>Кількість</th></tr>
            ${rows}
        </table>
    </body>
    </html>`;
    
    // Створюємо папку public і кладемо туди файл
    if (!fs.existsSync('public')) fs.mkdirSync('public');
    fs.writeFileSync('public/index.html', html);
}

async function main() {
    const token = await getAccessToken();
    const realmIds = await getRealms(token);
    
    console.log(`🚀 Починаю сканування ${realmIds.length} серверів...`);
    const allFoundItems = [];
    const limit = pLimit(CONCURRENCY);

    // 1. Спочатку скануємо Commodities (Реагенти) - це окремий запит
    // (Код для commodities такий самий, просто інший URL. Для спрощення поки пропускаємо, 
    // зосередимось на серверах, як ти просив в архітектурі)

    // 2. Скануємо сервери
    const tasks = realmIds.map(id => limit(async () => {
        const name = await getRealmName(id, token);
        await scanServer(id, name, token, allFoundItems);
        process.stdout.write('.'); // Індикатор прогресу
    }));

    await Promise.all(tasks);
    
    console.log(`\n✅ Знайдено ${allFoundItems.length} лотів.`);
    await generateHTML(allFoundItems);
}

main();