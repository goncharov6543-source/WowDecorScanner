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
const api = axios.create({ timeout: 60000 });

// Змінні для даних
let metaData = {};
let marketData = {};
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

// --- ID HELPER FUNCTIONS ---
function safeId(value) { return parseInt(value, 10); }
function getMainItemIds() { return new Set(itemsData.map(i => safeId(i.id))); }
function getReagentIds() {
    const ids = new Set();
    itemsData.forEach(item => {
        if (item.recipe) item.recipe.forEach(r => ids.add(safeId(r.id)));
    });
    return ids;
}
function getAllIdsArray() {
    const main = getMainItemIds();
    const reag = getReagentIds();
    return Array.from(new Set([...main, ...reag]));
}

// --- API FETCH FUNCTIONS ---
async function fetchMeta(rawId, token) {
    const itemId = safeId(rawId);
    if (metaData[itemId]) return;

    try {
        const mediaRes = await api.get(`https://${REGION}.api.blizzard.com/data/wow/media/item/${itemId}?namespace=static-${REGION}&locale=en_GB`, {
            headers: { Authorization: `Bearer ${token}` }
        });
        const iconUrl = mediaRes.data.assets.find(a => a.key === 'icon').value;
        
        let name = "Unknown Item";
        const jsonItem = itemsData.find(i => safeId(i.id) === itemId);
        if (jsonItem) {
            name = jsonItem.name;
        } else {
            itemsData.forEach(main => {
                const r = main.recipe?.find(reag => safeId(reag.id) === itemId);
                if (r) name = r.name;
            });
        }
        metaData[itemId] = { name, icon: iconUrl };
    } catch (e) {
        metaData[itemId] = { name: `Item ${itemId}`, icon: 'https://wow.zamimg.com/images/wow/icons/large/inv_misc_questionmark.jpg' };
    }
}

async function scanCommodities(token, allTargetIdsSet) {
    console.log("📦 Скачую базу Commodities...");
    try {
        const url = `https://${REGION}.api.blizzard.com/data/wow/auctions/commodities?namespace=dynamic-${REGION}&locale=en_GB`;
        const res = await api.get(url, { headers: { Authorization: `Bearer ${token}` } });
        
        res.data.auctions.forEach(lot => {
            const id = lot.item.id; 
            if (allTargetIdsSet.has(id)) {
                const price = lot.unit_price / 10000;
                if (!commoditiesMap[id] || price < commoditiesMap[id]) commoditiesMap[id] = price;
            }
        });
        console.log(`✅ Commodities: знайдено ціни для ${Object.keys(commoditiesMap).length} предметів.`);
    } catch (e) { console.error("❌ Помилка Commodities:", e.message); }
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
            if (mainItemIdsSet.has(itemId)) {
                const price = (lot.buyout || lot.unit_price) / 10000;
                if (!localBest[itemId] || price < localBest[itemId]) localBest[itemId] = price;
            }
        });
        Object.keys(localBest).forEach(id => { marketData[realmName][id] = localBest[id]; });
    } catch (e) { /* Ignore */ }
}

// --- GENERATE HTML ---
async function generateHTML() {
    console.log("📝 Прораховую прибутковість та генерую звіт...");
    
    if (!fs.existsSync('public')) fs.mkdirSync('public');
    if (fs.existsSync('import.js')) {
        fs.copyFileSync('import.js', 'public/import.js');
    }

    // 1. Спочатку прораховуємо всі дані (щоб можна було відсортувати)
    const calculatedItems = itemsData.map(item => {
        const itemId = safeId(item.id);
        let listings = [];
        
        // Збираємо лістинги
        Object.keys(marketData).forEach(realmName => {
            const price = marketData[realmName][itemId];
            if (price) listings.push({ r: realmName, p: price });
        });

        if (commoditiesMap[itemId]) {
            for(let i=0; i<3; i++) listings.push({ r: "Region (Commodity)", p: commoditiesMap[itemId] });
        }

        // Якщо лістингів немає, повертаємо пустий об'єкт для фільтрації
        if (listings.length === 0) return { valid: false };

        listings.sort((a, b) => a.p - b.p);
        const bestListing = listings[0];
        
        // Рахуємо крафт
        let craftCost = 0;
        let missingReagents = false;
        
        if (item.recipe) {
            item.recipe.forEach(reag => {
                const reagId = safeId(reag.id);
                const reagPrice = commoditiesMap[reagId];
                if (!reagPrice) missingReagents = true;
                craftCost += (reagPrice || 0) * reag.count;
            });
        }

        // Рахуємо Lumber Price (основний показник для сортування)
        let lumberPrice = -Infinity; // За замовчуванням дуже малий
        if (item.craftQty > 0 && !missingReagents) {
            lumberPrice = (bestListing.p - craftCost) / item.craftQty;
        }

        return {
            valid: true,
            item,
            itemId,
            listings,
            bestListing,
            craftCost,
            missingReagents,
            lumberPrice
        };
    });

    // 2. Фільтруємо валідні та СОРТУЄМО за Lumber Price (від найбільшого)
    const sortedItems = calculatedItems
        .filter(data => data.valid)
        .sort((a, b) => b.lumberPrice - a.lumberPrice);

    // 3. Генеруємо HTML
    const rows = sortedItems.map(data => {
        const { item, itemId, listings, bestListing, craftCost, missingReagents, lumberPrice } = data;
        const top3 = listings.slice(0, 3);

        // Генерація HTML рецепта
        let recipeHtml = '';
        if (item.recipe && item.recipe.length > 0) {
            recipeHtml = '<ul class="recipe-list">';
            item.recipe.forEach(reag => {
                const reagId = safeId(reag.id);
                const reagPrice = commoditiesMap[reagId];
                const reagMeta = metaData[reagId] || { icon: '', name: '?' };
                recipeHtml += `
                    <li>
                        <div class="reag-left">
                            <span class="reagent-count">${reag.count}x</span>
                            <img src="${reagMeta.icon}" class="reag-icon">
                            <span class="reagent-name">${reagMeta.name}</span>
                        </div>
                        <div class="reag-right">
                             ${reagPrice ? Math.round(reagPrice).toLocaleString() : '?'} <img src="https://wow.zamimg.com/images/wow/icons/large/inv_misc_coin_01.jpg" class="coin-xs">
                        </div>
                    </li>`;
            });
            recipeHtml += '</ul>';
        } else {
            recipeHtml = '<div class="empty-state">No recipe</div>';
        }

        let lumberClass = "neutral";
        if (lumberPrice > 0) lumberClass = "positive";
        else if (lumberPrice < 0) lumberClass = "negative";

        const top3Html = top3.map(l => `
            <div class="server-row">
                <span class="server-name">${l.r}</span>
                <span class="server-price">${l.p.toLocaleString()} <img src="https://wow.zamimg.com/images/wow/icons/large/inv_misc_coin_01.jpg" class="coin-sm"></span>
            </div>
        `).join('');

        const mainIcon = metaData[itemId]?.icon || '';
        const expLabel = item.Exp ? `<div class="col-exp">${item.Exp}</div>` : '<div class="col-exp"></div>';
        const recipeJson = JSON.stringify(item.recipe || []).replace(/"/g, '&quot;');
        const displayLumber = lumberPrice === -Infinity ? 'N/A' : Math.floor(lumberPrice).toLocaleString();

        return `
        <div class="item-card" data-recipe="${recipeJson}">
            <div class="main-row">
                <div class="main-row-left">
                    <div class="col-icon"><img src="${mainIcon}" alt="${item.name}"></div>
                    <div class="col-name">
                        <div class="name-text" onclick="copyName(event, '${item.name.replace(/'/g, "\\'")}')">
                            ${item.name}
                            <span class="copy-tooltip">Скопійовано!</span>
                        </div>
                    </div>
                    ${expLabel}
                </div>

                <div class="main-row-right" onclick="toggleDetails(this.closest('.item-card'))">
                    <div class="col-lumber ${lumberClass}">
                        <span class="lumber-label">1 Lumber = </span>
                        <span class="lumber-value">${displayLumber}</span>
                        <img src="https://wow.zamimg.com/images/wow/icons/large/inv_misc_coin_01.jpg" class="coin-xs">
                    </div>
                    <div class="col-price">
                        <span class="gold-amount">${bestListing.p.toLocaleString()}</span>
                        <img src="https://wow.zamimg.com/images/wow/icons/large/inv_misc_coin_01.jpg" class="gold-icon">
                    </div>
                    <div class="col-inputs" onclick="event.stopPropagation()">
                        <input type="number" class="qty-input" placeholder="0" min="0">
                        <input type="checkbox" class="check-input">
                    </div>
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
            body { background: #0f1011; color: #e0e0e0; font-family: 'Segoe UI', sans-serif; padding: 20px; margin: 0; color-scheme: dark; }
            .container { max-width: 1100px; margin: 0 auto; }
            .header-container { position: relative; display: flex; justify-content: center; align-items: center; margin-bottom: 40px; padding-top: 10px; }
            h1 { margin: 0; color: #fff; font-weight: 300; letter-spacing: 1px; }
            .header-right { position: absolute; right: 0; top: 0; display: flex; flex-direction: column; align-items: flex-end; gap: 10px; }
            .update-time { font-size: 0.85em; color: #666; }
            .btn-import { background: #a335ee; color: white; border: none; padding: 8px 16px; border-radius: 4px; cursor: pointer; font-weight: bold; font-size: 0.9em; transition: background 0.2s; }
            .btn-import:hover { background: #8a2be2; }
            .item-card { background: #1a1b1d; border-radius: 8px; margin-bottom: 12px; border: 1px solid #2a2b2e; transition: all 0.2s ease; }
            .item-card:hover { border-color: #444; background: #202124; }
            .item-card.active { border-color: #a335ee; box-shadow: 0 0 15px rgba(163, 53, 238, 0.1); }
            .main-row { display: flex; height: 60px; position: relative; z-index: 2; }
            .main-row-left { display: flex; align-items: center; flex-grow: 1; padding-left: 20px; }
            .main-row-right { display: flex; align-items: center; padding-right: 20px; cursor: pointer; }
            .col-icon img { width: 42px; height: 42px; border-radius: 4px; border: 1px solid #333; display: block; }
            .col-name { flex-grow: 1; padding-left: 20px; display: flex; align-items: center; }
            .name-text { font-weight: 600; font-size: 1.1em; color: #a335ee; position: relative; cursor: copy; transition: color 0.2s; }
            .name-text:hover { color: #fff; text-decoration: underline; }
            .col-exp { width: 150px; text-align: center; color: #888; font-size: 0.85em; background: #252629; padding: 4px 8px; border-radius: 4px; margin-right: 20px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
            .col-lumber { margin-right: 20px; display: flex; align-items: center; gap: 5px; font-size: 0.95em; padding: 4px 10px; border-radius: 4px; background: rgba(255,255,255,0.05); }
            .lumber-label { color: #888; font-size: 0.8em; text-transform: uppercase; margin-right: 5px; }
            .lumber-value { font-weight: bold; font-size: 1.1em; }
            .col-lumber.positive .lumber-value { color: #4caf50; }
            .col-lumber.negative .lumber-value { color: #f44336; }
            .col-price { display: flex; align-items: center; gap: 8px; font-weight: bold; font-size: 1.2em; color: #f0f0f0; min-width: 100px; justify-content: flex-end; }
            .gold-icon { width: 18px; height: 18px; border-radius: 50%; }
            .coin-xs { width: 10px; height: 10px; vertical-align: middle; }
            .col-inputs { display: flex; align-items: center; gap: 15px; margin-left: 25px; border-left: 1px solid #333; padding-left: 15px; height: 40px; cursor: default; }
            .qty-input { background: #0f1011; border: 1px solid #333; color: #fff; width: 50px; padding: 6px; border-radius: 4px; text-align: center; font-weight: bold; }
            .qty-input:focus { outline: 1px solid #a335ee; }
            .check-input { width: 18px; height: 18px; accent-color: #a335ee; cursor: pointer; }
            input::-webkit-outer-spin-button, input::-webkit-inner-spin-button { -webkit-appearance: none; margin: 0; }
            input[type=number] { -moz-appearance: textfield; }
            .copy-tooltip { position: absolute; left: 100%; top: 50%; transform: translateY(-50%); background: #4caf50; color: white; padding: 4px 8px; border-radius: 4px; font-size: 12px; margin-left: 10px; opacity: 0; pointer-events: none; transition: opacity 0.2s; white-space: nowrap; z-index: 100; box-shadow: 0 2px 5px rgba(0,0,0,0.5); }
            .name-text.copied .copy-tooltip { opacity: 1; }
            .details-row { max-height: 0; overflow: hidden; transition: max-height 0.3s ease-out; background: #151618; border-top: 1px solid #2a2b2e; position: relative; z-index: 1; }
            .item-card.active .details-row { max-height: 500px; } 
            .details-content { padding: 20px; display: flex; gap: 30px; }
            .reagents-block { flex: 1.2; padding-right: 20px; border-right: 1px solid #333; }
            .servers-block { flex: 0.8; }
            .servers-block h4 { margin-bottom: 25px; }
            h4 { margin: 0; color: #888; font-size: 0.9em; text-transform: uppercase; letter-spacing: 1px; }
            .block-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 15px; }
            .total-craft-cost { font-weight: bold; color: #f44336; font-size: 0.95em; }
            .recipe-list { list-style: none; padding: 0; margin: 0; }
            .recipe-list li { display: flex; justify-content: space-between; align-items: center; padding: 6px 0; border-bottom: 1px solid #222; font-size: 0.9em; }
            .reag-left { display: flex; align-items: center; gap: 8px; }
            .reag-icon { width: 24px; height: 24px; border-radius: 3px; border: 1px solid #444; }
            .reagent-count { color: #ffd700; font-weight: bold; min-width: 25px; }
            .reagent-name { color: #ccc; }
            .reag-right { color: #ccc; font-size: 0.9em; display: flex; align-items: center; gap: 4px; }
            .craft-qty-info { margin-top: 15px; font-size: 0.9em; color: #4caf50; font-weight: bold; background: rgba(76, 175, 80, 0.1); padding: 8px; border-radius: 4px; text-align: center; }
            .empty-state { color: #555; font-style: italic; font-size: 0.9em; }
            .server-row { display: flex; justify-content: space-between; padding: 8px 0; border-bottom: 1px solid #222; font-size: 0.95em; }
            .server-name { color: #ccc; }
            .server-price { color: #ffd700; font-weight: bold; display: flex; align-items: center; gap: 4px; }
            .coin-sm { width: 12px; height: 12px; }
        </style>
    </head>
    <body>
        <div class="container">
            <div class="header-container">
                <h1>💎 WoW Profit Scanner</h1>
                <div class="header-right">
                    <span class="update-time">Оновлено: ${new Date().toLocaleString()}</span>
                    <button class="btn-import">Згенерувати Import</button>
                </div>
            </div>
            
            <div id="list">${rows}</div>
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
        <script src="import.js"></script>
    </body>
    </html>`;
    
    fs.writeFileSync('public/index.html', html);
}

// --- MAIN ---
async function main() {
    const token = await getAccessToken();
    const mainItemIdsSet = getMainItemIds();
    const allIdsArray = getAllIdsArray();
    const allTargetIdsSet = new Set(allIdsArray.map(id => safeId(id)));

    console.log(`🖼️ Завантажую іконки для ${allIdsArray.length} об'єктів...`);
    const metaLimit = pLimit(10);
    await Promise.all(allIdsArray.map(id => metaLimit(() => fetchMeta(id, token))));

    await scanCommodities(token, allTargetIdsSet);

    const realmIds = await getRealms(token);
    console.log(`🚀 Сканую ${realmIds.length} серверів...`);
    
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