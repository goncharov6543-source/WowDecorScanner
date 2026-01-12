const axios = require('axios');
const fs = require('fs');
const pLimit = require('p-limit');

// --- ЗАВАНТАЖУЄМО БАЗУ ПРЕДМЕТІВ ---
// Якщо файлу немає, скрипт впаде з помилкою (і це правильно)
const itemsData = require('./items.json');

// --- КОНФІГУРАЦІЯ ---
const CLIENT_ID = process.env.BLIZZARD_CLIENT_ID;
const CLIENT_SECRET = process.env.BLIZZARD_CLIENT_SECRET;
const REGION = 'eu';

const CONCURRENCY = 20; 
const api = axios.create({ timeout: 20000 });

// Карта предметів
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

// --- ПІДГОТОВКА ДАНИХ (Merge JSON + Blizzard API) ---
async function fetchItemDetails(configItem, token) {
    const itemId = parseInt(configItem.id); // Гарантуємо, що це число
    
    try {
        // Ми беремо назву з твого JSON, тому запит до API item/ID можна пропустити,
        // АЛЕ нам потрібна картинка.
        
        const mediaRes = await api.get(`https://${REGION}.api.blizzard.com/data/wow/media/item/${itemId}?namespace=static-${REGION}&locale=en_GB`, {
            headers: { Authorization: `Bearer ${token}` }
        });

        const iconUrl = mediaRes.data.assets.find(a => a.key === 'icon').value;

        itemsMap[itemId] = {
            id: itemId,
            name: configItem.name,   // Беремо з твого JSON
            icon: iconUrl,           // Беремо з Blizzard
            craftQty: configItem.craftQty || 0,
            recipe: configItem.recipe || [], // Зберігаємо рецепт
            listings: []
        };
        console.log(`📦 Завантажено: ${configItem.name}`);
    } catch (e) {
        console.error(`Помилка інфо ${itemId} (можливо ID змінився?)`);
        // Навіть якщо помилка API, створюємо об'єкт, щоб не загубити рецепт
        itemsMap[itemId] = {
            id: itemId,
            name: configItem.name,
            icon: 'https://wow.zamimg.com/images/wow/icons/large/inv_misc_questionmark.jpg',
            craftQty: configItem.craftQty || 0,
            recipe: configItem.recipe || [],
            listings: []
        };
    }
}

// --- ОТРИМАННЯ СЕРВЕРІВ ---
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
        return res.data.realms[0].name;
    } catch (e) { return `Realm-${id}`; }
}

// --- СКАНУВАННЯ ---
async function scanServer(realmId, realmName, token) {
    try {
        const url = `https://${REGION}.api.blizzard.com/data/wow/connected-realm/${realmId}/auctions?namespace=dynamic-${REGION}&locale=en_GB`;
        const res = await api.get(url, { headers: { Authorization: `Bearer ${token}` } });
        
        res.data.auctions.forEach(lot => {
            const itemId = lot.item.id;
            if (itemsMap[itemId]) {
                const price = (lot.buyout || lot.unit_price) / 10000;
                itemsMap[itemId].listings.push({
                    p: price,
                    r: realmName,
                    q: lot.quantity
                });
            }
        });
    } catch (e) { /* tss */ }
}

// --- ГЕНЕРАЦІЯ HTML ---
async function generateHTML() {
    console.log("📝 Генерую звіт...");
    
    const sortedItems = Object.values(itemsMap).filter(i => i.listings.length > 0);
    sortedItems.sort((a, b) => a.name.localeCompare(b.name));

    const rows = sortedItems.map((item) => {
        item.listings.sort((a, b) => a.p - b.p);
        
        const bestPrice = item.listings[0];
        const top3 = item.listings.slice(0, 3);

        // 1. Формуємо HTML для серверів
        const top3Html = top3.map(l => `
            <div class="server-row">
                <span class="server-name">${l.r}</span>
                <span class="server-price">${l.p.toLocaleString()} <img src="https://wow.zamimg.com/images/wow/icons/large/inv_misc_coin_01.jpg" class="coin-sm"></span>
            </div>
        `).join('');

        // 2. Формуємо HTML для рецептів (з json)
        let recipeHtml = '';
        if (item.recipe && item.recipe.length > 0) {
            recipeHtml = '<ul class="recipe-list">';
            item.recipe.forEach(reagent => {
                recipeHtml += `
                    <li>
                        <span class="reagent-count">${reagent.count}x</span> 
                        <span class="reagent-name">${reagent.name}</span>
                    </li>
                `;
            });
            recipeHtml += '</ul>';
            if (item.craftQty > 0) {
                 recipeHtml += `<div class="craft-qty-info">Lumber cost: ${item.craftQty}</div>`;
            }
        } else {
            recipeHtml = '<div class="empty-state">No recipe data in items.json</div>';
        }

        return `
        <div class="item-card" onclick="toggleDetails(this)">
            <div class="main-row">
                <div class="col-icon"><img src="${item.icon}" alt="${item.name}"></div>
                <div class="col-name">
                    <div class="name-text" onclick="copyName(event, '${item.name.replace(/'/g, "\\'")}')">
                        ${item.name}
                        <span class="copy-tooltip">Скопійовано!</span>
                    </div>
                </div>
                <div class="col-price">
                    <span class="gold-amount">${bestPrice.p.toLocaleString()}</span>
                    <img src="https://wow.zamimg.com/images/wow/icons/large/inv_misc_coin_01.jpg" class="gold-icon">
                </div>
            </div>

            <div class="details-row">
                <div class="details-content">
                    <div class="reagents-block">
                        <h4>🛠️ Recipe / Info</h4>
                        ${recipeHtml}
                    </div>
                    <div class="servers-block">
                        <h4>🏆 Топ-3 Сервери</h4>
                        ${top3Html}
                    </div>
                </div>
            </div>
        </div>
        `;
    }).join('');

    const html = `
    <!DOCTYPE html>
    <html lang="uk">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>WoW Decor Scanner</title>
        <style>
            body { background: #0f1011; color: #e0e0e0; font-family: 'Segoe UI', sans-serif; padding: 20px; margin: 0; }
            .container { max-width: 800px; margin: 0 auto; }
            h1 { text-align: center; color: #fff; margin-bottom: 40px; font-weight: 300; letter-spacing: 1px; }
            
            .item-card { background: #1a1b1d; border-radius: 8px; margin-bottom: 12px; overflow: hidden; border: 1px solid #2a2b2e; transition: all 0.2s ease; cursor: pointer; }
            .item-card:hover { border-color: #444; background: #202124; }
            .item-card.active { border-color: #a335ee; box-shadow: 0 0 15px rgba(163, 53, 238, 0.1); }

            .main-row { display: flex; align-items: center; padding: 12px 20px; height: 60px; }
            .col-icon img { width: 42px; height: 42px; border-radius: 4px; border: 1px solid #333; display: block; }
            .col-name { flex-grow: 1; padding-left: 20px; display: flex; align-items: center; }
            .name-text { font-weight: 600; font-size: 1.1em; color: #a335ee; position: relative; cursor: copy; transition: color 0.2s; }
            .name-text:hover { color: #fff; text-decoration: underline; }
            .col-price { display: flex; align-items: center; gap: 8px; font-weight: bold; font-size: 1.2em; color: #f0f0f0; }
            .gold-icon { width: 18px; height: 18px; border-radius: 50%; }

            .copy-tooltip { position: absolute; left: 100%; top: 50%; transform: translateY(-50%); background: #4caf50; color: white; padding: 4px 8px; border-radius: 4px; font-size: 12px; margin-left: 10px; opacity: 0; pointer-events: none; transition: opacity 0.2s; white-space: nowrap; }
            .name-text.copied .copy-tooltip { opacity: 1; }

            .details-row { max-height: 0; overflow: hidden; transition: max-height 0.3s ease-out; background: #151618; border-top: 1px solid #2a2b2e; }
            .item-card.active .details-row { max-height: 400px; } /* Трохи збільшив для рецептів */
            
            .details-content { padding: 20px; display: flex; gap: 20px; }
            .reagents-block { flex: 1; padding-right: 20px; border-right: 1px solid #333; }
            .servers-block { flex: 0.6; }
            h4 { margin: 0 0 15px 0; color: #888; font-size: 0.9em; text-transform: uppercase; letter-spacing: 1px; }
            
            /* Styles for Recipe List */
            .recipe-list { list-style: none; padding: 0; margin: 0; }
            .recipe-list li { display: flex; justify-content: space-between; padding: 4px 0; border-bottom: 1px solid #222; font-size: 0.9em; }
            .reagent-count { color: #ffd700; font-weight: bold; margin-right: 10px; }
            .reagent-name { color: #ccc; }
            .craft-qty-info { margin-top: 10px; font-size: 0.85em; color: #4caf50; font-weight: bold; }
            .empty-state { color: #555; font-style: italic; font-size: 0.9em; }

            .server-row { display: flex; justify-content: space-between; padding: 6px 0; border-bottom: 1px solid #222; font-size: 0.95em; }
            .server-name { color: #ccc; }
            .server-price { color: #ffd700; font-weight: bold; display: flex; align-items: center; gap: 4px; }
            .coin-sm { width: 12px; height: 12px; }

            .footer { text-align: center; color: #444; margin-top: 40px; font-size: 0.8em; }
        </style>
    </head>
    <body>
        <div class="container">
            <h1>💎 WoW Decor Scanner</h1>
            <div id="list">${rows}</div>
            <div class="footer">Оновлено: ${new Date().toLocaleString()}</div>
        </div>
        <script>
            function toggleDetails(card) { card.classList.toggle('active'); }
            function copyName(event, text) {
                event.stopPropagation();
                navigator.clipboard.writeText(text).then(() => {
                    const el = event.currentTarget;
                    el.classList.add('copied');
                    setTimeout(() => el.classList.remove('copied'), 1500);
                });
            }
        </script>
    </body>
    </html>`;
    
    if (!fs.existsSync('public')) fs.mkdirSync('public');
    fs.writeFileSync('public/index.html', html);
}

// --- MAIN ---
async function main() {
    const token = await getAccessToken();
    
    console.log("🖼️ Processing items from JSON...");
    // Тепер ми йдемо не по масиву ID, а по об'єктах з items.json
    for (const itemConfig of itemsData) {
        await fetchItemDetails(itemConfig, token);
    }

    const realmIds = await getRealms(token);
    
    console.log(`🚀 Scanning ${realmIds.length} realms...`);
    const limit = pLimit(CONCURRENCY);

    const tasks = realmIds.map(id => limit(async () => {
        const name = await getRealmName(id, token);
        await scanServer(id, name, token);
        process.stdout.write('.');
    }));

    await Promise.all(tasks);
    
    console.log("Done.");
    await generateHTML();
}

main();