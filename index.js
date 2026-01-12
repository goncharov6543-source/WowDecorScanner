const axios = require('axios');
const fs = require('fs');
const pLimit = require('p-limit');

// --- КОНФІГУРАЦІЯ ---
const CLIENT_ID = process.env.BLIZZARD_CLIENT_ID;
const CLIENT_SECRET = process.env.BLIZZARD_CLIENT_SECRET;
const REGION = 'eu';

// ТВІЙ СПИСОК БАЖАНЬ (ID предметів)
// Додавай сюди будь-які ID через кому
const WANTED_ITEMS = [
    258215, // Weavercloth Bolt
    258191,  // Reins of Poseidus
    262347, // Example Decor
    258195  // Another Item
];

const CONCURRENCY = 20; 
const api = axios.create({ timeout: 20000 });

// Зберігаємо результати тут: { 210933: { name: '...', icon: '...', minPrice: Infinity, realm: '...' } }
let itemsMap = {};

// --- АВТОРИЗАЦІЯ ---
async function getAccessToken() {
    console.log("🔑 Отримую токен...");
    const auth = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64');
    const res = await api.post('https://oauth.battle.net/token', 'grant_type=client_credentials', {
        headers: { 'Authorization': `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' }
    });
    return res.data.access_token;
}

// --- ОТРИМАННЯ ДАНИХ ПРО ПРЕДМЕТ (Назва + Картинка) ---
async function fetchItemDetails(itemId, token) {
    try {
        // 1. Отримуємо загальну інфу (Назва)
        const itemRes = await api.get(`https://${REGION}.api.blizzard.com/data/wow/item/${itemId}?namespace=static-${REGION}&locale=en_GB`, {
            headers: { Authorization: `Bearer ${token}` }
        });
        
        // 2. Отримуємо картинку (Media)
        const mediaRes = await api.get(`https://${REGION}.api.blizzard.com/data/wow/media/item/${itemId}?namespace=static-${REGION}&locale=en_GB`, {
            headers: { Authorization: `Bearer ${token}` }
        });

        const iconUrl = mediaRes.data.assets.find(a => a.key === 'icon').value;

        // Ініціалізуємо об'єкт у нашій базі
        itemsMap[itemId] = {
            id: itemId,
            name: itemRes.data.name,
            icon: iconUrl,
            minPrice: Infinity, // Поки що ціна нескінченна
            realm: "Не знайдено",
            qty: 0
        };
        console.log(`📦 Завантажено інфо: ${itemRes.data.name}`);
    } catch (e) {
        console.error(`Помилка отримання інфо про предмет ${itemId}`);
    }
}

// --- ОТРИМАННЯ СПИСКУ СЕРВЕРІВ ---
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

// --- ОТРИМАННЯ НАЗВИ СЕРВЕРА ---
async function getRealmName(id, token) {
    try {
        const res = await api.get(`https://${REGION}.api.blizzard.com/data/wow/connected-realm/${id}?namespace=dynamic-${REGION}&locale=en_GB`, {
            headers: { Authorization: `Bearer ${token}` }
        });
        return res.data.realms[0].name;
    } catch (e) { return `Realm-${id}`; }
}

// --- СКАНУВАННЯ АУКЦІОНУ ---
async function scanServer(realmId, realmName, token) {
    try {
        const url = `https://${REGION}.api.blizzard.com/data/wow/connected-realm/${realmId}/auctions?namespace=dynamic-${REGION}&locale=en_GB`;
        const res = await api.get(url, { headers: { Authorization: `Bearer ${token}` } });
        
        // Проходимо по лотах
        res.data.auctions.forEach(lot => {
            const itemId = lot.item.id;
            
            // Якщо цей предмет є в нашому списку
            if (itemsMap[itemId]) {
                const price = (lot.buyout || lot.unit_price) / 10000; // Конвертуємо в золото
                
                // ГОЛОВНА ЛОГІКА: Якщо ціна менша за поточну мінімальну -> оновлюємо
                if (price < itemsMap[itemId].minPrice) {
                    itemsMap[itemId].minPrice = price;
                    itemsMap[itemId].realm = realmName;
                    itemsMap[itemId].qty = lot.quantity;
                }
            }
        });
    } catch (e) { /* Ігноруємо помилки */ }
}

// --- ГЕНЕРАЦІЯ КРАСИВОГО HTML ---
async function generateHTML() {
    console.log("📝 Генерую звіт...");
    
    // Перетворюємо itemsMap назад у масив для сортування
    const itemsArray = Object.values(itemsMap).filter(i => i.minPrice !== Infinity);
    
    // Сортуємо за назвою
    itemsArray.sort((a, b) => a.name.localeCompare(b.name));

    const rows = itemsArray.map(item => `
        <tr class="item-row">
            <td class="icon-cell">
                <div class="item-wrapper">
                    <img src="${item.icon}" alt="${item.name}">
                    <div class="item-info">
                        <span class="item-name">${item.name}</span>
                        <span class="item-id">ID: ${item.id}</span>
                    </div>
                </div>
            </td>
            <td class="price-cell">
                <span class="gold">${item.minPrice.toLocaleString()} g</span>
            </td>
            <td>${item.realm}</td>
        </tr>
    `).join('');

    const html = `
    <!DOCTYPE html>
    <html lang="uk">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>WoW Low Price Finder</title>
        <style>
            body { background: #121212; color: #e0e0e0; font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; padding: 20px; margin: 0; }
            .container { max-width: 900px; margin: 0 auto; }
            h1 { text-align: center; color: #fff; margin-bottom: 30px; }
            
            table { width: 100%; border-collapse: separate; border-spacing: 0 10px; }
            
            .item-row { background: #1e1e1e; transition: transform 0.2s; }
            .item-row:hover { transform: scale(1.01); background: #252525; box-shadow: 0 4px 15px rgba(0,0,0,0.3); }
            
            td { padding: 15px; border-top: 1px solid #333; border-bottom: 1px solid #333; }
            td:first-child { border-left: 1px solid #333; border-radius: 8px 0 0 8px; }
            td:last-child { border-right: 1px solid #333; border-radius: 0 8px 8px 0; font-weight: bold; color: #aaa; }

            .item-wrapper { display: flex; align-items: center; gap: 15px; }
            img { width: 46px; height: 46px; border-radius: 6px; border: 1px solid #444; }
            
            .item-info { display: flex; flex-direction: column; }
            .item-name { font-weight: bold; font-size: 1.1em; color: #a335ee; } /* Epic purple color */
            .item-id { font-size: 0.8em; color: #666; }
            
            .price-cell { text-align: right; }
            .gold { color: #ffd700; font-weight: bold; font-size: 1.2em; }
            
            .update-time { text-align: center; color: #555; margin-top: 30px; font-size: 0.9em; }
        </style>
    </head>
    <body>
        <div class="container">
            <h1>💎 Найнижчі ціни (EU Region)</h1>
            
            <table>
                ${rows}
            </table>

            <div class="update-time">Останнє оновлення: ${new Date().toLocaleString()}</div>
        </div>
    </body>
    </html>`;
    
    if (!fs.existsSync('public')) fs.mkdirSync('public');
    fs.writeFileSync('public/index.html', html);
}

// --- ГОЛОВНА ФУНКЦІЯ ---
async function main() {
    const token = await getAccessToken();
    
    // 1. Спочатку завантажуємо назви та іконки для всіх предметів
    console.log("🖼️ Завантажуємо метадані предметів...");
    for (const id of WANTED_ITEMS) {
        await fetchItemDetails(id, token);
    }

    // 2. Отримуємо сервери
    const realmIds = await getRealms(token);
    
    console.log(`🚀 Починаю сканування ${realmIds.length} серверів...`);
    const limit = pLimit(CONCURRENCY);

    // 3. Скануємо
    const tasks = realmIds.map(id => limit(async () => {
        const name = await getRealmName(id, token);
        await scanServer(id, name, token);
        process.stdout.write('.');
    }));

    await Promise.all(tasks);
    
    console.log("\n✅ Сканування завершено.");
    await generateHTML();
}

main();