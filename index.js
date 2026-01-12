const axios = require('axios');
const fs = require('fs');
const pLimit = require('p-limit');

// --- ЗАВАНТАЖУЄМО БАЗУ ПРЕДМЕТІВ ---
const itemsData = require('./items.json');

// --- КОНФІГУРАЦІЯ ---
const CLIENT_ID = process.env.BLIZZARD_CLIENT_ID;
const CLIENT_SECRET = process.env.BLIZZARD_CLIENT_SECRET;
const REGION = 'eu';

const CONCURRENCY = 20; 
const api = axios.create({ timeout: 60000 }); // Збільшив тайм-аут, бо файл реагентів великий

// metaData[itemId] = { name, icon }
let metaData = {};
// marketData[realmName][itemId] = price (Тут тільки Декори)
let marketData = {};
// commoditiesMap[itemId] = price (Тут тільки Реагенти, ціна одна на весь регіон)
let commoditiesMap = {};

// --- АВТОРИЗАЦІЯ ---
async function getAccessToken() {
    console.log("🔑 Отримую токен...");
    const auth = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64');
    const res = await api.post('https://oauth.battle.net/token', 'grant_type=client_credentials', {
        headers: { 'Authorization': `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' }
    });
    return res.data.access_token;
}

// --- ДОПОМІЖНІ ФУНКЦІЇ ДЛЯ ID ---
function getMainItemIds() {
    return new Set(itemsData.map(i => i.id));
}

function getReagentIds() {
    const ids = new Set();
    itemsData.forEach(item => {
        if (item.recipe) {
            item.recipe.forEach(r => ids.add(r.id));
        }
    });
    return ids;
}

function getAllIdsArray() {
    const main = getMainItemIds();
    const reag = getReagentIds();
    return Array.from(new Set([...main, ...reag]));
}

// --- ОТРИМАННЯ КАРТИНОК І НАЗВ ---
async function fetchMeta(itemId, token) {
    if (metaData[itemId]) return;

    try {
        const mediaRes = await api.get(`https://${REGION}.api.blizzard.com/data/wow/media/item/${itemId}?namespace=static-${REGION}&locale=en_GB`, {
            headers: { Authorization: `Bearer ${token}` }
        });
        const iconUrl = mediaRes.data.assets.find(a => a.key === 'icon').value;
        
        let name = "Unknown Item";
        const jsonItem = itemsData.find(i => i.id === itemId);
        if (jsonItem) {
            name = jsonItem.name;
        } else {
            itemsData.forEach(main => {
                const r = main.recipe?.find(reag => reag.id === itemId);
                if (r) name = r.name;
            });
        }

        metaData[itemId] = { name, icon: iconUrl };
    } catch (e) {
        metaData[itemId] = { name: `Item ${itemId}`, icon: 'https://wow.zamimg.com/images/wow/icons/large/inv_misc_questionmark.jpg' };
    }
}

// --- КРОК 1: СКАНУВАННЯ РЕАГЕНТІВ (COMMODITIES) ---
async function scanCommodities(token, reagentIdsSet) {
    console.log("📦 Скачую базу регіональних цін (Commodities)...");
    try {
        const url = `https://${REGION}.api.blizzard.com/data/wow/auctions/commodities?namespace=dynamic-${REGION}&locale=en_GB`;
        const res = await api.get(url, { headers: { Authorization: `Bearer ${token}` } });
        
        // Файл величезний, тому фільтруємо відразу
        res.data.auctions.forEach(lot => {
            // Перевіряємо, чи цей лот є реагентом з нашого списку
            if (reagentIdsSet.has(lot.item.id)) {
                const price = lot.unit_price / 10000;
                
                // Зберігаємо найменшу ціну
                if (!commoditiesMap[lot.item.id] || price < commoditiesMap[lot.item.id]) {
                    commoditiesMap[lot.item.id] = price;
                }
            }
        });
        console.log(`✅ Знайдено ціни на ${Object.keys(commoditiesMap).length} реагентів.`);
    } catch (e) {
        console.error("❌ Помилка сканування Commodities:", e.message);
    }
}

// --- КРОК 2: СКАНУВАННЯ СЕРВЕРІВ (Тільки Декор) ---
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

async function scanServer(realmId, realmName, token, mainItemIdsSet) {
    try {
        const url = `https://${REGION}.api.blizzard.com/data/wow/connected-realm/${realmId}/auctions?namespace=dynamic-${REGION}&locale=en_GB`;
        const res = await api.get(url, { headers: { Authorization: `Bearer ${token}` } });
        
        if (!marketData[realmName]) marketData[realmName] = {};
        let localBest = {}; 

        res.data.auctions.forEach(lot => {
            const itemId = lot.item.id;
            
            // Тут шукаємо ТІЛЬКИ готові предмети (декор)
            if (mainItemIdsSet.has(itemId)) {
                const price = (lot.buyout || lot.unit_price) / 10000;
                if (!localBest[itemId] || price < localBest[itemId]) {
                    localBest[itemId] = price;
                }
            }
        });

        Object.keys(localBest).forEach(id => {
            marketData[realmName][id] = localBest[id];
        });

    } catch (e) { /* Ігноруємо помилки серверів */ }
}

// --- ГЕНЕРАЦІЯ HTML ---
async function generateHTML() {
    console.log("📝 Генерую звіт...");
    
    const reportItems = itemsData.sort((a, b) => a.name.localeCompare(b.name));

    const rows = reportItems.map((item) => {
        // 1. Шукаємо декор по серверах
        let listings = [];
        Object.keys(marketData).forEach(realmName => {
            const price = marketData[realmName][item.id];
            if (price) {
                listings.push({ r: realmName, p: price });
            }
        });

        if (listings.length === 0) return '';

        listings.sort((a, b) => a.p - b.p);
        const top3 = listings.slice(0, 3);
        const bestListing = listings[0]; 

        // 2. Рахуємо ціну крафта (на основі регіональних цін Commodities)
        let craftCost = 0;
        let recipeHtml = '';
        let missingReagents = false;

        if (item.recipe && item.recipe.length > 0) {
            recipeHtml = '<ul class="recipe-list">';
            
            item.recipe.forEach(reag => {
                // БЕРЕМО ЦІНУ З РЕГІОНАЛЬНОЇ БАЗИ
                const reagPrice = commoditiesMap[reag.id];
                
                if (!reagPrice) missingReagents = true;

                const totalReagCost = (reagPrice || 0) * reag.count;
                craftCost += totalReagCost;
                
                const reagMeta = metaData[reag.id] || { icon: '', name: '?' };

                recipeHtml += `
                    <li>
                        <div class="reag-left">
                            <span class="reagent-count">${reag.count}x</span>
                            <img src="${reagMeta.icon}" class="reag-icon">
                            <span class="reagent-name">${reagMeta.name}</span>
                        </div>
                        <div class="reag-right">
                             ${reagPrice ? Math.round(reagPrice).toLocaleString() : '?'} <span class="gold-symbol">g</span>
                        </div>
                    </li>
                `;
            });
            recipeHtml += '</ul>';
        } else {
            recipeHtml = '<div class="empty-state">No recipe</div>';
        }

        // 3. Рахуємо Ламбер (Ціна сервера - Ціна регіон. реагентів)
        let lumberPrice = 0;
        let lumberClass = "neutral";
        
        if (item.craftQty > 0 && !missingReagents) {
            lumberPrice = (bestListing.p - craftCost) / item.craftQty;
            if (lumberPrice > 0) lumberClass = "positive";
            else lumberClass = "negative";
        }

        const top3Html = top3.map(l => `
            <div class="server-row">
                <span class="server-name">${l.r}</span>
                <span class="server-price">${l.p.toLocaleString()} <img src="https://wow.zamimg.com/images/wow/icons/large/inv_misc_coin_01.jpg" class="coin-sm"></span>
            </div>
        `).join('');

        const mainIcon = metaData[item.id]?.icon || '';

        return `
        <div class="item-card" onclick="toggleDetails(this)">
            <div class="main-row">
                <div class="col-icon"><img src="${mainIcon}" alt="${item.name}"></div>
                <div class="col-name">
                    <div class="name-text" onclick="copyName(event, '${item.name.replace(/'/g, "\\'")}')">
                        ${item.name}
                        <span class="copy-tooltip">Скопійовано!</span>
                    </div>
                </div>
                <div class="col-lumber ${lumberClass}">
                    <span class="lumber-label">1 Lumber = </span>
                    <span class="lumber-value">${Math.floor(lumberPrice).toLocaleString()}</span>
                    <img src="https://wow.zamimg.com/images/wow/icons/large/inv_misc_coin_01.jpg" class="coin-xs">
                </div>
                <div class="col-price">
                    <span class="gold-amount">${bestListing.p.toLocaleString()}</span>
                    <img src="https://wow.zamimg.com/images/wow/icons/large/inv_misc_coin_01.jpg" class="gold-icon">
                </div>
            </div>
            <div class="details-row">
                <div class="details-content">
                    <div class="reagents-block">
                        <div class="block-header">
                            <h4>🛠️ Recipe Cost (Region)</h4>
                            <span class="total-craft-cost text-red">Total: -${Math.floor(craftCost).toLocaleString()} g</span>
                        </div>
                        ${recipeHtml}
                        ${item.craftQty > 0 ? `<div class="craft-qty-info">Requires: <b>${item.craftQty}</b> Lumber</div>` : ''}
                    </div>
                    <div class="servers-block">
                        <h4>🏆 Топ-3 (Найдешевші)</h4>
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
        <title>WoW Profit Scanner</title>
        <style>
            body { background: #0f1011; color: #e0e0e0; font-family: 'Segoe UI', sans-serif; padding: 20px; margin: 0; }
            .container { max-width: 950px; margin: 0 auto; }
            h1 { text-align: center; color: #fff; margin-bottom: 40px; font-weight: 300; letter-spacing: 1px; }
            .item-card { background: #1a1b1d; border-radius: 8px; margin-bottom: 12px; border: 1px solid #2a2b2e; transition: all 0.2s ease; cursor: pointer; }
            .item-card:hover { border-color: #444; background: #202124; }
            .item-card.active { border-color: #a335ee; box-shadow: 0 0 15px rgba(163, 53, 238, 0.1); }
            .main-row { display: flex; align-items: center; padding: 12px 20px; height: 60px; position: relative; z-index: 2; }
            .col-icon img { width: 42px; height: 42px; border-radius: 4px; border: 1px solid #333; display: block; }
            .col-name { flex-grow: 1; padding-left: 20px; display: flex; align-items: center; }
            .name-text { font-weight: 600; font-size: 1.1em; color: #a335ee; position: relative; cursor: copy; transition: color 0.2s; }
            .name-text:hover { color: #fff; text-decoration: underline; }
            .col-lumber { margin-right: 30px; display: flex; align-items: center; gap: 5px; font-size: 0.95em; padding: 4px 10px; border-radius: 4px; background: rgba(255,255,255,0.05); }
            .lumber-label { color: #888; font-size: 0.8em; text-transform: uppercase; margin-right: 5px; }
            .lumber-value { font-weight: bold; font-size: 1.1em; }
            .col-lumber.positive .lumber-value { color: #4caf50; }
            .col-lumber.negative .lumber-value { color: #f44336; }
            .col-price { display: flex; align-items: center; gap: 8px; font-weight: bold; font-size: 1.2em; color: #f0f0f0; min-width: 120px; justify-content: flex-end; }
            .gold-icon { width: 18px; height: 18px; border-radius: 50%; }
            .coin-xs { width: 10px; height: 10px; vertical-align: middle; }
            .copy-tooltip { position: absolute; left: 100%; top: 50%; transform: translateY(-50%); background: #4caf50; color: white; padding: 4px 8px; border-radius: 4px; font-size: 12px; margin-left: 10px; opacity: 0; pointer-events: none; transition: opacity 0.2s; white-space: nowrap; z-index: 100; box-shadow: 0 2px 5px rgba(0,0,0,0.5); }
            .name-text.copied .copy-tooltip { opacity: 1; }
            .details-row { max-height: 0; overflow: hidden; transition: max-height 0.3s ease-out; background: #151618; border-top: 1px solid #2a2b2e; position: relative; z-index: 1; }
            .item-card.active .details-row { max-height: 500px; } 
            .details-content { padding: 20px; display: flex; gap: 30px; }
            .reagents-block { flex: 1.2; padding-right: 20px; border-right: 1px solid #333; }
            .servers-block { flex: 0.8; }
            h4 { margin: 0; color: #888; font-size: 0.9em; text-transform: uppercase; letter-spacing: 1px; }
            .block-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 15px; }
            .total-craft-cost { font-weight: bold; color: #f44336; font-size: 0.95em; }
            .recipe-list { list-style: none; padding: 0; margin: 0; }
            .recipe-list li { display: flex; justify-content: space-between; align-items: center; padding: 6px 0; border-bottom: 1px solid #222; font-size: 0.9em; }
            .reag-left { display: flex; align-items: center; gap: 8px; }
            .reag-icon { width: 24px; height: 24px; border-radius: 3px; border: 1px solid #444; }
            .reagent-count { color: #ffd700; font-weight: bold; min-width: 25px; }
            .reagent-name { color: #ccc; }
            .reag-right { color: #888; font-size: 0.9em; }
            .gold-symbol { color: #ffd700; font-size: 0.8em; }
            .craft-qty-info { margin-top: 15px; font-size: 0.9em; color: #4caf50; font-weight: bold; background: rgba(76, 175, 80, 0.1); padding: 8px; border-radius: 4px; text-align: center; }
            .empty-state { color: #555; font-style: italic; font-size: 0.9em; }
            .server-row { display: flex; justify-content: space-between; padding: 8px 0; border-bottom: 1px solid #222; font-size: 0.95em; }
            .server-name { color: #ccc; }
            .server-price { color: #ffd700; font-weight: bold; display: flex; align-items: center; gap: 4px; }
            .coin-sm { width: 12px; height: 12px; }
            .footer { text-align: center; color: #444; margin-top: 40px; font-size: 0.8em; }
        </style>
    </head>
    <body>
        <div class="container">
            <h1>💎 WoW Profit Scanner</h1>
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
    
    // 1. Отримуємо ID для сканування
    const mainItemIdsSet = getMainItemIds(); // Декори (для серверів)
    const reagentIdsSet = getReagentIds();   // Реагенти (для Commodities)
    const allIdsArray = getAllIdsArray();    // Все разом (для картинок)

    // 2. Вантажимо картинки
    console.log(`🖼️ Завантажую іконки для ${allIdsArray.length} об'єктів...`);
    const metaLimit = pLimit(10);
    await Promise.all(allIdsArray.map(id => metaLimit(() => fetchMeta(id, token))));

    // 3. Скануємо ЦІНИ НА РЕАГЕНТИ (Один запит на регіон)
    await scanCommodities(token, reagentIdsSet);

    // 4. Скануємо СЕРВЕРИ (Тільки декор)
    const realmIds = await getRealms(token);
    console.log(`🚀 Сканую ${realmIds.length} серверів (шукаємо ${mainItemIdsSet.size} видів декору)...`);
    
    const limit = pLimit(CONCURRENCY);
    const scanTasks = realmIds.map(id => limit(async () => {
        const name = await getRealmName(id, token);
        await scanServer(id, name, token, mainItemIdsSet);
        process.stdout.write('.');
    }));

    await Promise.all(scanTasks);
    
    console.log("\n✅ Готово.");
    await generateHTML();
}

main();