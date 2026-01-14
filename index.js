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

    const calculatedItems = itemsData.map(item => {
        const itemId = safeId(item.id);
        let listings = [];
        
        Object.keys(marketData).forEach(realmName => {
            const price = marketData[realmName][itemId];
            if (price) listings.push({ r: realmName, p: price });
        });

        if (commoditiesMap[itemId]) {
            for(let i=0; i<3; i++) listings.push({ r: "Region (Commodity)", p: commoditiesMap[itemId] });
        }

        if (listings.length === 0) return { valid: false };

        listings.sort((a, b) => a.p - b.p);
        const bestListing = listings[0];
        
        let craftCost = 0;
        let missingReagents = false;
        let reagentsList = [];
        
        if (item.recipe) {
            item.recipe.forEach(reag => {
                const reagId = safeId(reag.id);
                const reagPrice = reag.fixPrice || commoditiesMap[reagId];
                const reagMeta = metaData[reagId] || { icon: '', name: '?' };
                if (!reagPrice) missingReagents = true;
                
                craftCost += (reagPrice || 0) * reag.count;
                
                reagentsList.push({
                    name: reagMeta.name,
                    count: reag.count,
                    icon: reagMeta.icon,
                    price: reagPrice
                });
            });
        }

        let lumberPrice = -Infinity; 
        if (item.craftQty > 0 && !missingReagents) {
            lumberPrice = (bestListing.p - craftCost) / item.craftQty;
        }

        return {
            valid: true,
            itemId,
            name: item.name,
            icon: metaData[itemId]?.icon || '',
            exp: item.Exp,
            prof: item.Prof,
            recipeRaw: item.recipe || [],
            lumberPrice: lumberPrice,
            bestPrice: bestListing.p,
            craftCost: craftCost,
            craftQty: item.craftQty,
            reagentsList: reagentsList,
            top3: listings.slice(0, 3)
        };
    });

    const sortedItems = calculatedItems
        .filter(data => data.valid)
        .sort((a, b) => b.lumberPrice - a.lumberPrice);

    const jsonPayload = JSON.stringify(sortedItems);
    const updateTime = new Date().toLocaleString("uk-UA", { timeZone: "Europe/Kyiv" });

    const html = `
    <!DOCTYPE html>
    <html lang="uk">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>WoW Decor Scanner</title>
        <style>
            body { background: #0f1011; color: #e0e0e0; font-family: 'Segoe UI', sans-serif; padding: 20px; margin: 0; color-scheme: dark; }
            .container { max-width: 1200px; margin: 0 auto; padding-bottom: 50px; }
            
            /* --- ОНОВЛЕНИЙ ХЕДЕР --- */
            .header-container { 
                display: flex; 
                flex-direction: column;
                align-items: center; 
                margin-bottom: 30px; 
                padding-top: 10px;
                gap: 5px; /* Відступ між заголовком і датою */
            }

            h1 { margin: 0; color: #fff; font-weight: 300; letter-spacing: 1px; font-size: 2.5em; }
            
            .update-time { 
                font-size: 0.9em; 
                color: #666; 
                margin-bottom: 15px; 
            }

            /* Рядок керування: Пошук зліва, Кнопка справа */
            .controls-row {
                display: flex;
                justify-content: space-between;
                align-items: center;
                width: 100%;
                margin-top: 10px;
            }

            /* Стилі для поля пошуку */
            #smartSearchInput {
                background-color: #1a1a1a;
                border: 1px solid #333;
                color: #fff;
                padding: 0 15px; /* Паддінг тільки збоку */
                border-radius: 6px;
                width: 300px; 
                font-size: 14px;
                outline: none;
                transition: border-color 0.2s;
                height: 42px; /* Фіксована висота */
                box-sizing: border-box; /* Щоб бордер не ламав висоту */
            }
            #smartSearchInput:focus {
                border-color: #ffd700;
            }
            #smartSearchInput::placeholder {
                color: #666;
            }

            /* Стилі для кнопки імпорту */
            .btn-import { 
                background: #a335ee; 
                color: white; 
                border: none; 
                padding: 0 20px; 
                border-radius: 4px; 
                cursor: pointer; 
                font-weight: bold; 
                font-size: 0.95em; 
                transition: background 0.2s;
                height: 42px; /* Така сама висота як у інпута */
                box-sizing: border-box;
                display: flex;
                align-items: center;
                justify-content: center;
            }
            .btn-import:hover { background: #8a2be2; }
            /* ----------------------------- */

            .load-more-container { text-align: center; margin-top: 30px; }
            .btn-load-more { 
                background: #2a2b2e; color: #fff; border: 1px solid #444; 
                padding: 10px 30px; border-radius: 4px; cursor: pointer; 
                font-size: 1em; transition: all 0.2s; 
            }
            .btn-load-more:hover { background: #333; border-color: #666; }
            .hidden { display: none; }

            .item-card { background: #1a1b1d; border-radius: 8px; margin-bottom: 12px; border: 1px solid #2a2b2e; transition: all 0.2s ease; }
            .item-card:hover { border-color: #444; background: #202124; }
            .item-card.active { border-color: #a335ee; box-shadow: 0 0 15px rgba(163, 53, 238, 0.1); }
            
            .main-row { display: flex; height: 60px; position: relative; z-index: 2; }
            .main-row-left { display: flex; align-items: center; flex-grow: 1; padding-left: 20px; }
            .main-row-right { display: flex; align-items: center; padding-right: 20px; cursor: default; }
            
            .col-icon img { width: 42px; height: 42px; border-radius: 4px; border: 1px solid #333; display: block; }
            .col-name { flex-grow: 1; padding-left: 20px; display: flex; align-items: center; }
            .name-text { font-weight: 600; font-size: 1.1em; color: #a335ee; position: relative; cursor: copy; transition: color 0.2s; }
            .name-text:hover { color: #fff; text-decoration: underline; }
            
            .info-badge {
                height: 34px;
                display: flex;
                align-items: center;
                justify-content: center;
                border-radius: 4px;
                font-size: 0.9em;
                box-sizing: border-box;
                white-space: nowrap;
            }

            .col-exp, .col-prof { 
                background: #252629; 
                color: #888; 
                width: auto;
                min-width: 100px;
                padding: 0 15px;
                margin-right: 10px;
            }
            
            .col-lumber { 
                margin-right: 15px; 
                background: rgba(255,255,255,0.05); 
                padding: 0 15px;
                cursor: pointer;
                transition: transform 0.1s;
                user-select: none;
            }
            .col-lumber:active { transform: scale(0.96); }

            .lumber-label { color: #888; font-size: 0.8em; text-transform: uppercase; margin-right: 5px; }
            .lumber-value { font-weight: bold; font-size: 1.1em; margin-right: 5px; }
            .col-lumber.positive .lumber-value { color: #4caf50; }
            .col-lumber.negative .lumber-value { color: #f44336; }
            .col-lumber.neutral .lumber-value { color: #aaa; }
            
            .col-price { 
                display: flex; align-items: center; gap: 8px; font-weight: bold; font-size: 1.2em; color: #f0f0f0; 
                min-width: 140px; justify-content: flex-end; 
                cursor: pointer;
                user-select: none;
                transition: transform 0.1s;
            }
            .col-price:active { transform: scale(0.96); }
            
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
                <h1>💎 WoW Decor Scanner</h1>
                
                <div class="update-time">Оновлено: ${updateTime}</div>
                
                <div class="controls-row">
                    <input type="text" id="smartSearchInput" placeholder="Пошук: назва, патч або профа...">
                    <button class="btn-import">Згенерувати Import</button>
                </div>
            </div>
            
            <div id="list"></div>
            
            <div class="load-more-container">
                <button id="btnLoadMore" class="btn-load-more">Показати ще (20)</button>
            </div>
        </div>
        
        <script>
            const ALL_DATA = ${jsonPayload};
            
            let activeData = ALL_DATA; 
            let currentIndex = 0;
            const ITEMS_PER_PAGE = 20;

            function toggleDetails(card) { card.classList.toggle('active'); }
            
            function copyName(event, text) {
                event.stopPropagation();
                navigator.clipboard.writeText(text).then(() => {
                    const el = event.currentTarget;
                    el.classList.add('copied');
                    setTimeout(() => el.classList.remove('copied'), 1500);
                });
            }

            function createItemHTML(item) {
                const recipeJson = JSON.stringify(item.recipeRaw).replace(/"/g, '&quot;');
                
                const expLabel = item.exp ? \`<div class="col-exp info-badge">\${item.exp}</div>\` : '<div class="col-exp info-badge"></div>';
                const profLabel = item.prof ? \`<div class="col-prof info-badge">\${item.prof}</div>\` : '';
                
                let lumberClass = "neutral";
                if (item.lumberPrice > 0) lumberClass = "positive";
                else if (item.lumberPrice < 0 && item.lumberPrice !== -Infinity) lumberClass = "negative";

                const displayLumber = item.lumberPrice === -Infinity ? 'N/A' : Math.floor(item.lumberPrice).toLocaleString();
                const displayPrice = Math.floor(item.bestPrice).toLocaleString();

                let recipeHtml = '';
                if (item.reagentsList && item.reagentsList.length > 0) {
                    recipeHtml = '<ul class="recipe-list">';
                    item.reagentsList.forEach(r => {
                         recipeHtml += \`
                            <li>
                                <div class="reag-left">
                                    <span class="reagent-count">\${r.count}x</span>
                                    <img src="\${r.icon}" class="reag-icon">
                                    <span class="reagent-name">\${r.name}</span>
                                </div>
                                <div class="reag-right">
                                     \${r.price ? r.price.toLocaleString(undefined, {minimumFractionDigits: 0, maximumFractionDigits: 2}) : '?'} <img src="https://wow.zamimg.com/images/wow/icons/large/inv_misc_coin_01.jpg" class="coin-xs">
                                </div>
                            </li>\`;
                    });
                    recipeHtml += '</ul>';
                } else {
                    recipeHtml = '<div class="empty-state">No recipe</div>';
                }

                const top3Html = item.top3.map(l => \`
                    <div class="server-row">
                        <span class="server-name">\${l.r}</span>
                        <span class="server-price">\${l.p.toLocaleString()} <img src="https://wow.zamimg.com/images/wow/icons/large/inv_misc_coin_01.jpg" class="coin-sm"></span>
                    </div>
                \`).join('');

                return \`
                <div class="item-card" data-recipe="\${recipeJson}">
                    <div class="main-row">
                        <div class="main-row-left">
                            <div class="col-icon"><img src="\${item.icon}" alt="\${item.name}"></div>
                            <div class="col-name">
                                <div class="name-text" onclick="copyName(event, '\${item.name.replace(/'/g, "\\\\'")}')">
                                    \${item.name}
                                    <span class="copy-tooltip">Скопійовано!</span>
                                </div>
                            </div>
                            \${expLabel}
                            \${profLabel} </div>

                        <div class="main-row-right">
                            <div class="col-lumber info-badge \${lumberClass}" onclick="toggleDetails(this.closest('.item-card'))">
                                <span class="lumber-label">1 Lumber = </span>
                                <span class="lumber-value">\${displayLumber}</span>
                                <img src="https://wow.zamimg.com/images/wow/icons/large/inv_misc_coin_01.jpg" class="coin-xs">
                            </div>
                            <div class="col-price" onclick="toggleDetails(this.closest('.item-card'))">
                                <span class="gold-amount">\${displayPrice}</span>
                                <img src="https://wow.zamimg.com/images/wow/icons/large/inv_misc_coin_01.jpg" class="gold-icon">
                            </div>
                            <div class="col-inputs">
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
                                    <span class="total-craft-cost text-red">Total: -\${Math.floor(item.craftCost).toLocaleString()} <img src="https://wow.zamimg.com/images/wow/icons/large/inv_misc_coin_01.jpg" class="coin-xs"></span>
                                </div>
                                \${recipeHtml}
                                \${item.craftQty > 0 ? \`<div class="craft-qty-info">Requires: <b>\${item.craftQty}</b> Lumber</div>\` : ''}
                            </div>
                            <div class="servers-block">
                                <h4>🏆 Топ-3 (Найдешевші)</h4>
                                \${top3Html}
                            </div>
                        </div>
                    </div>
                </div>\`;
            }

            function loadMore() {
                const list = document.getElementById('list');
                const btn = document.getElementById('btnLoadMore');
                
                const nextItems = activeData.slice(currentIndex, currentIndex + ITEMS_PER_PAGE);
                
                if (nextItems.length > 0) {
                    const html = nextItems.map(item => createItemHTML(item)).join('');
                    list.insertAdjacentHTML('beforeend', html);
                    currentIndex += nextItems.length;
                }

                if (currentIndex >= activeData.length) {
                    btn.classList.add('hidden');
                } else {
                    btn.classList.remove('hidden');
                }
            }

            function handleSearch(e) {
                const term = e.target.value.toLowerCase();
                const list = document.getElementById('list');
                const btn = document.getElementById('btnLoadMore');

                const filtered = ALL_DATA.filter(item => {
                    const inName = item.name.toLowerCase().includes(term);
                    const inExp = item.exp ? item.exp.toLowerCase().includes(term) : false;
                    const inProf = item.prof ? item.prof.toLowerCase().includes(term) : false;
                    
                    return inName || inExp || inProf;
                });

                filtered.sort((a, b) => b.lumberPrice - a.lumberPrice);

                activeData = filtered;
                currentIndex = 0;
                list.innerHTML = ''; 

                if (activeData.length === 0) {
                    list.innerHTML = '<div style="text-align:center; padding:20px; color:#666;">Нічого не знайдено</div>';
                    btn.classList.add('hidden');
                } else {
                    loadMore();
                }
            }

            document.addEventListener('DOMContentLoaded', () => {
                loadMore();
                document.getElementById('btnLoadMore').addEventListener('click', loadMore);
                document.getElementById('smartSearchInput').addEventListener('input', handleSearch);
            });
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