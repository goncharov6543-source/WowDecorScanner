const axios = require('axios');
const fs = require('fs');
const pLimit = require('p-limit');
const path = require('path');

// --- ЗАВАНТАЖУЄМО БАЗУ ПРЕДМЕТІВ ---
const itemsData = require('./items.json');

// --- КОНФІГУРАЦІЯ ---
const CLIENT_ID = process.env.BLIZZARD_CLIENT_ID;
const CLIENT_SECRET = process.env.BLIZZARD_CLIENT_SECRET;
const REGION = 'eu';

const CONCURRENCY = 20; 
const HISTORY_FILE = 'price_history.json';
const HISTORY_LIMIT = 8760; // 1 рік історії (годин)

const api = axios.create({ timeout: 60000 });

// Змінні для даних
let metaData = {};
let marketData = {};
let commoditiesMap = {};
let historyDB = {};

// --- АВТОРИЗАЦІЯ ---
async function getAccessToken() {
    console.log("🔑 Отримую токен...");
    try {
        const auth = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64');
        const res = await api.post('https://oauth.battle.net/token', 'grant_type=client_credentials', {
            headers: { 'Authorization': `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' }
        });
        return res.data.access_token;
    } catch (e) {
        console.error("❌ Помилка авторизації! Перевір Secret/ID.");
        process.exit(1);
    }
}

// --- ІСТОРІЯ ЦІН (ВАЖЛИВО) ---
function loadHistory() {
    if (fs.existsSync(HISTORY_FILE)) {
        try {
            const raw = fs.readFileSync(HISTORY_FILE, 'utf8');
            historyDB = JSON.parse(raw);
            console.log(`📂 Історію завантажено: ${Object.keys(historyDB).length} предметів.`);
        } catch (e) {
            console.error("⚠️ Помилка читання історії, створюю нову базу.");
            historyDB = {};
        }
    } else {
        console.log("⚠️ Файлу історії немає, створюю новий.");
        historyDB = {};
    }
}

function updateHistory(itemId, price) {
    if (!price) return;
    // Ініціалізація масиву, якщо його немає
    if (!historyDB[itemId]) historyDB[itemId] = [];
    
    const timestamp = Date.now();
    
    // Додаємо нову точку
    historyDB[itemId].push({ t: timestamp, p: price });
    
    // Сортуємо по часу (про всяк випадок)
    historyDB[itemId].sort((a, b) => a.t - b.t);

    // Видаляємо старі записи, якщо їх забагато
    if (historyDB[itemId].length > HISTORY_LIMIT) {
        historyDB[itemId] = historyDB[itemId].slice(-HISTORY_LIMIT);
    }
}

function saveHistory() {
    try {
        fs.writeFileSync(HISTORY_FILE, JSON.stringify(historyDB, null, 2)); // null, 2 для форматування
        console.log("💾 Історію успішно збережено у файл.");
    } catch (e) {
        console.error("❌ Помилка збереження історії:", e);
    }
}

// --- HELPER FUNCTIONS ---
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
    console.log("📝 Генерую звіт...");
    
    const FAVICON_NAME = 'homestone.jpg'; 

    if (!fs.existsSync('public')) fs.mkdirSync('public');
    if (fs.existsSync('import.js')) fs.copyFileSync('import.js', 'public/import.js');

    if (fs.existsSync(FAVICON_NAME)) {
        fs.copyFileSync(FAVICON_NAME, path.join('public', FAVICON_NAME));
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
        
        // --- ОНОВЛЕННЯ ІСТОРІЇ ---
        updateHistory(itemId, bestListing.p);

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
            exp: item.Exp || 'Unknown',
            prof: item.Prof,
            recipeRaw: item.recipe || [],
            lumberPrice: lumberPrice,
            bestPrice: bestListing.p,
            craftCost: craftCost,
            craftQty: item.craftQty,
            reagentsList: reagentsList,
            top10: listings.slice(0, 10),
            // Передаємо історію в HTML
            history: historyDB[itemId] || []
        };
    });

    // --- ЗБЕРІГАЄМО ІСТОРІЮ ПІСЛЯ ОБРОБКИ ВСІХ ПРЕДМЕТІВ ---
    saveHistory();

    const sortedItems = calculatedItems
        .filter(data => data.valid)
        .sort((a, b) => b.lumberPrice - a.lumberPrice);

    const expStats = {};
    sortedItems.forEach(item => {
        if (item.lumberPrice > -999999) {
            const exp = item.exp;
            if (!expStats[exp]) expStats[exp] = { sum: 0, count: 0 };
            expStats[exp].sum += item.lumberPrice;
            expStats[exp].count += 1;
        }
    });

    let expTooltipHtml = '';
    const sortedStats = Object.keys(expStats).map(exp => {
        return {
            name: exp,
            avg: expStats[exp].sum / expStats[exp].count
        };
    });
    sortedStats.sort((a, b) => b.avg - a.avg);

    sortedStats.forEach(stat => {
        const colorClass = stat.avg > 0 ? '#4caf50' : '#f44336';
        expTooltipHtml += `
            <div class="stat-row">
                <span class="stat-name">${stat.name}</span>
                <span class="stat-val" style="color:${colorClass}">${Math.floor(stat.avg).toLocaleString()} <img src="https://wow.zamimg.com/images/wow/icons/large/inv_misc_coin_01.jpg" class="coin-xs"></span>
            </div>`;
    });

    const jsonPayload = JSON.stringify(sortedItems);
    const updateTime = new Date().toLocaleString("uk-UA", { timeZone: "Europe/Kyiv" });

    const html = `
    <!DOCTYPE html>
    <html lang="uk">
    <head>
        <meta charset="UTF-8">
        <title>WoW Decor Scanner</title>
        <link rel="icon" type="image/jpeg" href="${FAVICON_NAME}">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
        <style>
            body { background: #0f1011; color: #e0e0e0; font-family: 'Segoe UI', sans-serif; padding: 20px; margin: 0; color-scheme: dark; }
            .container { max-width: 1300px; margin: 0 auto; padding-bottom: 50px; }
            .header-container { display: flex; flex-direction: column; align-items: center; margin-bottom: 30px; gap: 5px; }
            h1 { margin: 0; color: #fff; font-weight: 300; letter-spacing: 1px; font-size: 2.5em; }
            .update-time { font-size: 0.9em; color: #666; margin-bottom: 15px; }
            .controls-row { display: flex; justify-content: space-between; align-items: center; width: 100%; margin-top: 10px; }
            #smartSearchInput { background-color: #1a1a1a; border: 1px solid #333; color: #fff; padding: 0 15px; border-radius: 6px; width: 300px; outline: none; height: 42px; }
            #smartSearchInput:focus { border-color: #ffd700; }
            .buttons-group { display: flex; gap: 15px; align-items: center; }
            button { border: none; padding: 0 20px; border-radius: 4px; cursor: pointer; font-weight: bold; height: 42px; color: white; transition: 0.2s; }
            .btn-import { background: #a335ee; }
            .btn-import:hover { background: #8a2be2; }
            .btn-import-addon { background: #00bcd4; }
            .btn-import-addon:hover { background: #00acc1; }
            .stats-wrapper { position: relative; display: flex; align-items: center; }
            .stats-icon { width: 30px; height: 30px; background: #333; border: 1px solid #555; color: #fff; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-family: serif; font-weight: bold; font-style: italic; font-size: 18px; cursor: help; transition: 0.2s; }
            .stats-icon:hover { background: #ffd700; color: #000; border-color: #ffd700; }
            .stats-tooltip { visibility: hidden; opacity: 0; position: absolute; top: 120%; right: 0; width: 250px; background: #1a1b1d; border: 1px solid #444; border-radius: 8px; padding: 15px; z-index: 100; box-shadow: 0 5px 20px rgba(0,0,0,0.5); transition: 0.2s; transform: translateY(-5px); }
            .stats-wrapper:hover .stats-tooltip { visibility: visible; opacity: 1; transform: translateY(0); }
            .stats-title { font-size: 14px; color: #888; text-transform: uppercase; margin-bottom: 10px; border-bottom: 1px solid #333; padding-bottom: 5px; text-align: center; }
            .stat-row { display: flex; justify-content: space-between; margin-bottom: 6px; font-size: 13px; }
            .stat-name { color: #ccc; }
            .stat-val { font-weight: bold; }
            input::-webkit-outer-spin-button, input::-webkit-inner-spin-button { -webkit-appearance: none; margin: 0; }
            input[type=number] { -moz-appearance: textfield; }
            .load-more-container { text-align: center; margin-top: 30px; }
            .btn-load-more { background: #2a2b2e; border: 1px solid #444; color: #fff; }
            .btn-load-more:hover { background: #333; }
            .hidden { display: none; }
            .item-card { background: #1a1b1d; border-radius: 8px; margin-bottom: 12px; border: 1px solid #2a2b2e; transition: all 0.2s ease; }
            .item-card:hover { border-color: #444; background: #202124; }
            .item-card.active { border-color: #a335ee; box-shadow: 0 0 15px rgba(163, 53, 238, 0.1); }
            .main-row { display: flex; height: 60px; position: relative; z-index: 2; }
            .main-row-left { display: flex; align-items: center; flex-grow: 1; padding-left: 20px; }
            .main-row-right { display: flex; align-items: center; padding-right: 20px; }
            .col-icon img { width: 42px; height: 42px; border-radius: 4px; border: 1px solid #333; display: block; }
            .col-name { flex-grow: 1; padding-left: 20px; display: flex; align-items: center; }
            .name-text { font-weight: 600; font-size: 1.1em; color: #a335ee; cursor: pointer; position: relative; }
            .info-badge { height: 34px; display: flex; align-items: center; justify-content: center; border-radius: 4px; font-size: 0.9em; padding: 0 15px; margin-right: 10px; background: #252629; color: #888; }
            .col-lumber { cursor: pointer; background: rgba(255,255,255,0.05); user-select: none; display: flex; align-items: center; }
            .col-lumber.positive span.val { color: #4caf50; font-weight: bold; }
            .col-lumber.negative span.val { color: #f44336; font-weight: bold; }
            .col-price { display: flex; align-items: center; gap: 8px; font-weight: bold; font-size: 1.2em; color: #f0f0f0; min-width: 140px; justify-content: flex-end; cursor: pointer; }
            .col-inputs { display: flex; align-items: center; gap: 15px; margin-left: 25px; border-left: 1px solid #333; padding-left: 15px; height: 40px; }
            .qty-input { background: #0f1011; border: 1px solid #333; color: #fff; width: 50px; padding: 6px; border-radius: 4px; text-align: center; font-weight:bold; }
            .check-input { width: 18px; height: 18px; accent-color: #a335ee; cursor: pointer; }
            .details-row { max-height: 0; overflow: hidden; transition: max-height 0.3s ease-out; background: #151618; border-top: 1px solid #2a2b2e; }
            .item-card.active .details-row { max-height: 800px; } 
            .details-content { display: flex; padding: 20px; gap: 20px; }
            .details-left { flex: 2; display: flex; flex-direction: column; gap: 20px; }
            .details-right { flex: 1; border-left: 1px solid #333; padding-left: 20px; max-height: 500px; overflow-y: auto; }
            .reagents-block { padding: 15px; background: #111; border-radius: 6px; border: 1px solid #333; }
            .chart-wrapper { background: #111; border: 1px solid #2a2b2e; border-radius: 8px; padding: 10px; height: 250px; position: relative; }
            .chart-controls { position: absolute; top: 10px; left: 10px; z-index: 10; display: flex; gap: 5px; }
            .chart-btn { background: #222; border: 1px solid #333; color: #888; padding: 2px 8px; border-radius: 3px; font-size: 11px; cursor: pointer; height: auto; }
            .chart-btn:hover { color: #fff; background: #333; }
            .chart-btn.active { background: #0070dd; color: #fff; border-color: #0070dd; }
            h4 { margin: 0 0 15px 0; color: #888; font-size: 0.9em; text-transform: uppercase; letter-spacing: 1px; }
            .recipe-list { list-style: none; padding: 0; margin: 0; }
            .recipe-list li { display: flex; justify-content: space-between; align-items: center; padding: 6px 0; border-bottom: 1px solid #222; font-size: 0.9em; }
            .reag-left { display: flex; align-items: center; gap: 8px; }
            .reag-icon { width: 24px; height: 24px; border-radius: 3px; border: 1px solid #444; }
            .coin-xs { width: 12px; height: 12px; vertical-align: middle; }
            .server-row { display: flex; justify-content: space-between; padding: 6px 0; font-size: 0.9em; border-bottom: 1px solid #222; }
            .server-price { color: #ffd700; font-weight: bold; }
            .copy-tooltip { position: absolute; left: 100%; top: 50%; transform: translateY(-50%); background: #4caf50; color: white; padding: 4px 8px; border-radius: 4px; font-size: 12px; margin-left: 10px; opacity: 0; transition: opacity 0.2s; pointer-events: none; }
            .name-text.copied .copy-tooltip { opacity: 1; }
        </style>
    </head>
    <body>
        <div class="container">
            <div class="header-container">
                <h1>💎 WoW Decor Scanner</h1>
                <div class="update-time">Оновлено: ${updateTime}</div>
                <div class="controls-row">
                    <input type="text" id="smartSearchInput" placeholder="Назва, професія або патч...">
                    <div class="buttons-group">
                        <div class="stats-wrapper">
                            <div class="stats-icon">i</div>
                            <div class="stats-tooltip">
                                <div class="stats-title">Average / Lumber</div>
                                ${expTooltipHtml}
                            </div>
                        </div>
                        <button class="btn-import-addon">Lumber Import</button>
                        <button class="btn-import">Reagents Import</button>
                    </div>
                </div>
            </div>
            <div id="list"></div>
            <div class="load-more-container"><button id="btnLoadMore" class="btn-load-more">Показати ще</button></div>
        </div>
        
        <script>
            const ALL_DATA = ${jsonPayload};
            let activeData = ALL_DATA; 
            let currentIndex = 0;
            const ITEMS_PER_PAGE = 20;
            let activeCharts = {};
            let chartRanges = {}; 

            function toggleDetails(card, itemId) {
                card.classList.toggle('active');
                if (card.classList.contains('active')) {
                    setTimeout(() => drawChart(itemId), 50);
                }
            }
            
            function setChartRange(btn, itemId, range) {
                const parent = btn.parentElement;
                parent.querySelectorAll('.chart-btn').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                chartRanges[itemId] = range;
                if (activeCharts[itemId]) { activeCharts[itemId].destroy(); delete activeCharts[itemId]; }
                drawChart(itemId);
            }

            function drawChart(itemId) {
                const canvas = document.getElementById('chart-' + itemId);
                if (!canvas || activeCharts[itemId]) return;

                const itemData = ALL_DATA.find(i => i.itemId === itemId);
                if (!itemData || !itemData.history || itemData.history.length === 0) return;

                const ctx = canvas.getContext('2d');
                const gradient = ctx.createLinearGradient(0, 0, 0, 300);
                gradient.addColorStop(0, 'rgba(0, 112, 221, 0.6)');
                gradient.addColorStop(1, 'rgba(0, 112, 221, 0.0)');

                const range = chartRanges[itemId] || '1m';
                const now = Date.now();
                let cutoff = 0;
                switch(range) {
                    case '1w': cutoff = now - (7 * 24 * 60 * 60 * 1000); break;
                    case '1m': cutoff = now - (30 * 24 * 60 * 60 * 1000); break;
                    case '6m': cutoff = now - (180 * 24 * 60 * 60 * 1000); break;
                    case '1y': cutoff = now - (365 * 24 * 60 * 60 * 1000); break;
                    default: cutoff = 0;
                }

                const filteredHistory = itemData.history.filter(h => h.t >= cutoff);

                const labels = filteredHistory.map(h => {
                    const d = new Date(h.t);
                    return d.toLocaleDateString() + ' ' + d.getHours() + ':00';
                });
                const dataPoints = filteredHistory.map(h => h.p);

                activeCharts[itemId] = new Chart(ctx, {
                    type: 'line',
                    data: {
                        labels: labels,
                        datasets: [{
                            label: 'Price',
                            data: dataPoints,
                            borderColor: '#0070dd',
                            backgroundColor: gradient,
                            borderWidth: 2,
                            tension: 0.4,
                            fill: true,
                            pointRadius: 0,
                            pointHoverRadius: 6,
                            pointBackgroundColor: '#fff'
                        }]
                    },
                    options: {
                        responsive: true,
                        maintainAspectRatio: false,
                        interaction: { mode: 'index', intersect: false },
                        plugins: { 
                            legend: { display: false },
                            tooltip: {
                                backgroundColor: 'rgba(0,0,0,0.8)',
                                titleColor: '#fff',
                                bodyColor: '#0070dd',
                                displayColors: false,
                                callbacks: { label: (c) => c.parsed.y.toLocaleString() + ' g' }
                            }
                        },
                        scales: {
                            x: { display: false },
                            y: { display: false }
                        }
                    }
                });
            }

            function copyName(event, text) {
                event.stopPropagation();
                navigator.clipboard.writeText(text).then(() => {
                    const el = event.currentTarget;
                    el.classList.add('copied');
                    setTimeout(() => el.classList.remove('copied'), 1500);
                });
            }

            function handleAddonImport(e) {
                const btn = e.currentTarget;
                const checkedBoxes = document.querySelectorAll('.check-input:checked');
                if (checkedBoxes.length === 0) return alert("Вибери предмети галочками!");

                let summary = {}; 
                checkedBoxes.forEach(box => {
                    const card = box.closest('.item-card');
                    const qtyInput = card.querySelector('.qty-input');
                    const count = parseInt(qtyInput.value) || 0;
                    if (count > 0) {
                        const exp = card.dataset.exp; 
                        const lumberReq = parseInt(card.dataset.lumber) || 0;
                        const totalLumber = count * lumberReq;
                        if (exp && totalLumber > 0) {
                            if (summary[exp]) summary[exp] += totalLumber; else summary[exp] = totalLumber;
                        }
                    }
                });
                const payload = Object.keys(summary).map(exp => ({ "Exp": exp, "craftQty": summary[exp] }));
                if (payload.length === 0) return alert("Перевір кількість (> 0) або наявність параметрів дерева.");
                visualCopy(btn, JSON.stringify(payload));
            }

            function handleReagentsImport(e) {
                const btn = e.currentTarget;
                const checkedBoxes = document.querySelectorAll('.check-input:checked');
                if (checkedBoxes.length === 0) return alert("Вибери предмети галочками!");
                let reagentsMap = {};
                let hasItems = false;
                checkedBoxes.forEach(box => {
                    const card = box.closest('.item-card');
                    const qtyInput = card.querySelector('.qty-input');
                    const count = parseInt(qtyInput.value) || 0;
                    if (count > 0) {
                        hasItems = true;
                        try {
                            const recipe = JSON.parse(card.dataset.recipe);
                            if (Array.isArray(recipe)) {
                                recipe.forEach(r => {
                                    if (!reagentsMap[r.name]) reagentsMap[r.name] = 0;
                                    reagentsMap[r.name] += (r.count * count);
                                });
                            }
                        } catch(e) {}
                    }
                });
                if (!hasItems) return alert("Введи кількість предметів!");
                const listString = Object.entries(reagentsMap).map(([n, q]) => \`\${n} x\${q}\`).join('\\n');
                visualCopy(btn, listString);
            }

            function visualCopy(btn, text) {
                navigator.clipboard.writeText(text);
                const originalText = btn.innerText;
                const originalColor = btn.style.backgroundColor;
                btn.style.backgroundColor = "#4caf50";
                btn.innerText = "Скопійовано!";
                setTimeout(() => { btn.style.backgroundColor = originalColor; btn.innerText = originalText; }, 2000);
            }

            function createItemHTML(item) {
                const recipeJson = JSON.stringify(item.recipeRaw).replace(/"/g, '&quot;');
                let recipeHtml = item.reagentsList && item.reagentsList.length > 0 ? '<ul class="recipe-list">' + item.reagentsList.map(r => \`<li><div class="reag-left"><span style="color:#ffd700;font-weight:bold">\${r.count}x</span> <img src="\${r.icon}" class="reag-icon"> <span>\${r.name}</span></div><div class="reag-right">\${Math.floor(r.price)} <img src="https://wow.zamimg.com/images/wow/icons/large/inv_misc_coin_01.jpg" class="coin-xs"></div></li>\`).join('') + '</ul>' : '<div style="color:#555">No recipe</div>';
                const top10Html = item.top10.map(l => \`<div class="server-row"><span>\${l.r}</span><span class="server-price">\${l.p.toLocaleString()} <img src="https://wow.zamimg.com/images/wow/icons/large/inv_misc_coin_01.jpg" class="coin-xs"></span></div>\`).join('');
                let lumberClass = item.lumberPrice > 0 ? "positive" : (item.lumberPrice > -999999 ? "negative" : "neutral");
                const dispLumber = item.lumberPrice > -999999 ? Math.floor(item.lumberPrice).toLocaleString() : 'N/A';

                return \`
                <div class="item-card" data-recipe="\${recipeJson}" data-exp="\${item.exp || ''}" data-lumber="\${item.craftQty || 0}">
                    <div class="main-row">
                        <div class="main-row-left">
                            <div class="col-icon"><img src="\${item.icon}"></div>
                            <div class="col-name"><div class="name-text" onclick="copyName(event, '\${item.name.replace(/'/g, "\\\\'")}')">\${item.name}<span class="copy-tooltip">Скопійовано!</span></div></div>
                            \${item.exp ? \`<div class="info-badge">\${item.exp}</div>\` : ''}
                            \${item.prof ? \`<div class="info-badge">\${item.prof}</div>\` : ''}
                        </div>
                        <div class="main-row-right">
                            <div class="col-lumber info-badge \${lumberClass}" onclick="toggleDetails(this.closest('.item-card'), \${item.itemId})">
                                <span style="margin-right:5px;text-transform:uppercase;font-size:0.8em">1 Lumber = </span><span class="val">\${dispLumber}</span>
                                <img src="https://wow.zamimg.com/images/wow/icons/large/inv_misc_coin_01.jpg" class="coin-xs" style="margin-left:4px">
                            </div>
                            <div class="col-price" onclick="toggleDetails(this.closest('.item-card'), \${item.itemId})">
                                <span>\${Math.floor(item.bestPrice).toLocaleString()}</span><img src="https://wow.zamimg.com/images/wow/icons/large/inv_misc_coin_01.jpg" style="width:18px;border-radius:50%">
                            </div>
                            <div class="col-inputs">
                                <input type="number" class="qty-input" placeholder="0" min="0">
                                <input type="checkbox" class="check-input">
                            </div>
                        </div>
                    </div>
                    <div class="details-row">
                        <div class="details-content">
                            <div class="details-left">
                                <div class="chart-wrapper">
                                    <div class="chart-controls">
                                        <button class="chart-btn" onclick="setChartRange(this, '\${item.itemId}', '1w')">1W</button>
                                        <button class="chart-btn active" onclick="setChartRange(this, '\${item.itemId}', '1m')">1M</button>
                                        <button class="chart-btn" onclick="setChartRange(this, '\${item.itemId}', '6m')">6M</button>
                                        <button class="chart-btn" onclick="setChartRange(this, '\${item.itemId}', '1y')">1Y</button>
                                    </div>
                                    <canvas id="chart-\${item.itemId}"></canvas>
                                </div>
                                <div class="reagents-block">
                                    <div style="display:flex;justify-content:space-between;margin-bottom:10px">
                                        <h4>Recipe Cost</h4>
                                        <span style="color:#f44336;font-weight:bold">Total: -\${Math.floor(item.craftCost).toLocaleString()} <img src="https://wow.zamimg.com/images/wow/icons/large/inv_misc_coin_01.jpg" class="coin-xs"></span>
                                    </div>
                                    \${recipeHtml}
                                    \${item.craftQty > 0 ? \`<div style="margin-top:10px;color:#4caf50;text-align:center;background:#1a3b1a;padding:5px;border-radius:4px">Requires: <b>\${item.craftQty}</b> Lumber</div>\` : ''}
                                </div>
                            </div>
                            <div class="details-right">
                                <h4>Cheapest Realms (Top 10)</h4>
                                \${top10Html}
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
                    list.insertAdjacentHTML('beforeend', nextItems.map(createItemHTML).join(''));
                    currentIndex += nextItems.length;
                }
                if (currentIndex >= activeData.length) btn.classList.add('hidden'); else btn.classList.remove('hidden');
            }

            function handleSearch(e) {
                const term = e.target.value.toLowerCase();
                const filtered = ALL_DATA.filter(i => {
                    const inName = i.name.toLowerCase().includes(term);
                    const inExp = i.exp && i.exp.toLowerCase().includes(term);
                    const inProf = i.prof && i.prof.toLowerCase().includes(term);
                    return inName || inExp || inProf;
                });
                filtered.sort((a, b) => b.lumberPrice - a.lumberPrice);
                activeData = filtered;
                currentIndex = 0;
                document.getElementById('list').innerHTML = '';
                loadMore();
            }

            document.addEventListener('DOMContentLoaded', () => {
                loadMore();
                document.getElementById('btnLoadMore').addEventListener('click', loadMore);
                document.getElementById('smartSearchInput').addEventListener('input', handleSearch);
                document.querySelector('.btn-import-addon').addEventListener('click', handleAddonImport);
                document.querySelector('.btn-import').addEventListener('click', handleReagentsImport);
            });
        </script>
        <script src="import.js"></script>
    </body>
    </html>`;
    
    fs.writeFileSync('public/index.html', html);
}

// --- MAIN ---
async function main() {
    loadHistory(); 
    
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
    console.log("\n✅ Сканування завершено.");
    
    await generateHTML(); 
}

main();