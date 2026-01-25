const axios = require('axios');
const fs = require('fs');
const pLimit = require('p-limit');
const path = require('path');

// --- ЗАВАНТАЖУЄМО БАЗУ ПРЕДМЕТІВ ---
const itemsData = require('./items.json');

// --- ЗАВАНТАЖУЄМО ВИМОГИ ДО СКІЛІВ ---
let skillNeededData = [];
try {
    if (fs.existsSync('./skill_needed.json')) {
        skillNeededData = require('./skill_needed.json');
        console.log("📘 Loaded skill_needed.json");
    } else {
        console.warn("⚠️ skill_needed.json not found. Crafter matching will not work.");
    }
} catch (e) {
    console.error("❌ Error loading skill_needed.json:", e.message);
}

// --- КОНФІГУРАЦІЯ ---
const CLIENT_ID = process.env.BLIZZARD_CLIENT_ID;
const CLIENT_SECRET = process.env.BLIZZARD_CLIENT_SECRET;
const REGION = 'eu';

const CONCURRENCY = 20; 
const HISTORY_FILE = 'price_history.json';
const HISTORY_LIMIT = 8760; 

const api = axios.create({ timeout: 60000 });

// Змінні для даних
let metaData = {};
let marketData = {};
let commoditiesMap = {};
let historyDB = {};

// --- АВТОРИЗАЦІЯ ---
async function getAccessToken() {
    console.log("🔑 Отримую токен...");
    const auth = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64');
    const res = await api.post('https://oauth.battle.net/token', 'grant_type=client_credentials', {
        headers: { 'Authorization': `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' }
    });
    return res.data.access_token;
}

// --- ІСТОРІЯ ЦІН ---
function loadHistory() {
    if (fs.existsSync(HISTORY_FILE)) {
        try {
            historyDB = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
            console.log(`📂 Завантажено історію цін для ${Object.keys(historyDB).length} предметів.`);
        } catch (e) {
            console.error("Помилка читання історії, створюю нову.");
            historyDB = {};
        }
    }
}

function updateHistory(itemId, price) {
    if (!price) return;
    if (!historyDB[itemId]) historyDB[itemId] = [];
    
    const timestamp = Date.now();
    historyDB[itemId].push({ t: timestamp, p: price });
    
    if (historyDB[itemId].length > HISTORY_LIMIT) {
        historyDB[itemId] = historyDB[itemId].slice(-HISTORY_LIMIT);
    }
}

function saveHistory() {
    fs.writeFileSync(HISTORY_FILE, JSON.stringify(historyDB));
    console.log("💾 Історію цін збережено.");
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

    // --- 1. Підготовка даних (Node.js) ---
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
            history: historyDB[itemId] || []
        };
    });

    saveHistory();

    const sortedItems = calculatedItems
        .filter(data => data.valid)
        .sort((a, b) => b.lumberPrice - a.lumberPrice);

    // --- Stats ---
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
        return { name: exp, avg: expStats[exp].sum / expStats[exp].count };
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
    const jsonSkillReq = JSON.stringify(skillNeededData);
    const updateTime = new Date().toLocaleString("uk-UA", { timeZone: "Europe/Kyiv" });

    // --- 2. HTML Template ---
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
            /* BASE STYLES */
            html, body { scrollbar-width: thin; scrollbar-color: #2a2b2e transparent; }
            body::-webkit-scrollbar { width: 10px; }
            body::-webkit-scrollbar-track { background: transparent; }
            body::-webkit-scrollbar-thumb { background: #2a2b2e; border-radius: 5px; border: 2px solid #0f1011; }
            body::-webkit-scrollbar-thumb:hover { background: #333; }
            body::-webkit-scrollbar-button { display: none; }

            body { background: #0f1011; color: #e0e0e0; font-family: 'Segoe UI', sans-serif; padding: 20px; margin: 0; color-scheme: dark; position: relative; }
            .container { max-width: 1300px; margin: 0 auto; padding-bottom: 50px; }
            .header-container { display: flex; flex-direction: column; align-items: center; margin-bottom: 30px; gap: 5px; position: relative; }
            h1 { margin: 0; color: #fff; font-weight: 300; letter-spacing: 1px; font-size: 2.5em; }
            .update-time { font-size: 0.9em; color: #666; margin-bottom: 15px; }
            .controls-row { display: flex; justify-content: space-between; align-items: center; width: 100%; margin-top: 10px; }
            
            .search-wrapper { display: flex; gap: 10px; align-items: center; }
            #smartSearchInput { background-color: #1a1a1a; border: 1px solid #333; color: #fff; padding: 0 15px; border-radius: 6px; width: 300px; outline: none; height: 42px; }
            #smartSearchInput:focus { border-color: #ffd700; }

            /* FORCE REMOVE INPUT ARROWS */
            input::-webkit-outer-spin-button,
            input::-webkit-inner-spin-button { -webkit-appearance: none !important; margin: 0 !important; }
            input[type=number] { -moz-appearance: textfield !important; }

            /* BUTTONS & ICONS */
            .stats-icon { width: 36px; height: 36px; background: #333; border: 1px solid #555; color: #fff; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-family: sans-serif; font-size: 18px; cursor: pointer; transition: 0.2s; user-select: none; padding: 0; line-height: 1; }
            .stats-icon:hover { background: #ffd700; color: #000; border-color: #ffd700; }
            .btn-reset { font-size: 22px; } 
            
            .buttons-group { display: flex; gap: 15px; align-items: center; }
            button { border: none; padding: 0 20px; border-radius: 4px; cursor: pointer; font-weight: bold; height: 42px; color: white; transition: 0.2s; display: flex; align-items: center; justify-content: center; }
            .btn-import { background: #a335ee; }
            .btn-import:hover { background: #8a2be2; }
            .btn-import-addon { background: #00bcd4; }
            .btn-import-addon:hover { background: #00acc1; }
            .btn-cart-rect { background: #333; color: #fff; border: 1px solid #555; gap: 8px; }
            .btn-cart-rect:hover { background: #444; border-color: #666; }
            
            /* INFO TOOLTIP */
            .stats-wrapper { position: relative; display: flex; align-items: center; }
            .stats-icon.info-btn { font-family: serif; font-weight: bold; font-style: italic; cursor: help; background: #333; color: #fff; border-color: #555; } 
            .stats-icon.info-btn:hover { background: #ffd700; color: #000; border-color: #ffd700; }
            .stats-tooltip { visibility: hidden; opacity: 0; position: absolute; top: 120%; left: 0; width: 280px; background: #1a1b1d; border: 1px solid #444; border-radius: 8px; padding: 15px; z-index: 100; box-shadow: 0 5px 20px rgba(0,0,0,0.5); transition: 0.2s; transform: translateY(-5px); }
            .stats-wrapper:hover .stats-tooltip { visibility: visible; opacity: 1; transform: translateY(0); }
            .stats-title { font-size: 13px; color: #888; text-transform: uppercase; margin-bottom: 10px; border-bottom: 1px solid #333; padding-bottom: 5px; text-align: center; letter-spacing: 1px; }
            .stat-row { display: flex; justify-content: space-between; margin-bottom: 6px; font-size: 13px; border-bottom: 1px solid #222; padding-bottom: 2px; }
            .stat-name { color: #ccc; }
            .stat-val { font-weight: bold; }
            
            /* TOP RIGHT SECTION (CHARACTERS) */
            #topRightSection { position: absolute; top: 20px; right: 30px; z-index: 100; }
            
            .add-char-btn { display: flex; flex-direction: column; align-items: center; cursor: pointer; }
            .add-char-circle {
                width: 60px; height: 60px; border: 2px dashed #444; border-radius: 50%;
                display: flex; align-items: center; justify-content: center;
                font-size: 32px; color: #444; transition: all 0.2s;
                background: transparent; line-height: 1; padding-bottom: 4px; 
            }
            .add-char-btn:hover .add-char-circle { border-color: #0070dd; color: #0070dd; }
            .add-char-label { margin-top: 10px; font-size: 13px; color: #444; transition: color 0.2s; }
            .add-char-btn:hover .add-char-label { color: #0070dd; }

            .char-menu-container { position: relative; }
            .btn-char-menu { 
                background: #2a2b2e; color: #ccc; border: 1px solid #444; 
                padding: 8px 16px; border-radius: 4px; cursor: pointer; font-weight: bold; font-size: 14px;
            }
            .btn-char-menu:hover { background: #333; color: #fff; }

            .char-dropdown {
                position: absolute; top: 100%; right: 0; margin-top: 10px;
                background: #111; border: 1px solid #333; border-radius: 8px;
                width: 340px; padding: 10px;
                display: flex; flex-direction: column; gap: 10px;
                box-shadow: 0 5px 20px rgba(0,0,0,0.5); z-index: 200;
                opacity: 0; visibility: hidden; transform: translateY(-10px);
                transition: all 0.3s ease;
            }
            .char-dropdown.active { opacity: 1; visibility: visible; transform: translateY(0); }

            .btn-add-new-char {
                background: transparent; border: 1px dashed #444; color: #888;
                width: 100%; padding: 10px; border-radius: 6px; cursor: pointer;
            }
            .btn-add-new-char:hover { border-color: #666; color: #fff; background: #1a1a1a; }

            /* CHAR TILE (TASK 1: Spacing added) */
            .char-tile {
                display: flex; align-items: center; background: #1a1b1d;
                border: 2px solid #0070dd; border-radius: 30px;
                padding: 6px 10px 6px 6px; gap: 10px;
                position: relative; transition: all 0.2s; min-height: 42px;
                margin-bottom: 10px; /* Spacing between tiles */
            }
            .char-tile:hover { background: #222; box-shadow: 0 0 10px rgba(0, 112, 221, 0.3); }
            
            .char-avatar { 
                width: 40px; height: 40px; border-radius: 50%; 
                border: 2px solid #ffd700; background-color: #222; 
                background-size: cover; background-position: center; flex-shrink: 0;
            }
            .char-info { display: flex; flex-direction: column; line-height: 1.2; overflow: hidden; flex-grow: 1; padding-right: 30px; }
            .char-name { font-weight: bold; color: #fff; font-size: 14px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
            .char-realm { font-size: 10px; color: #888; text-transform: uppercase; letter-spacing: 0.5px; }

            .tile-btn {
                position: absolute; width: 22px; height: 22px; border-radius: 50%;
                display: flex; align-items: center; justify-content: center;
                color: white; border: none; cursor: pointer;
                transition: transform 0.2s; z-index: 10; flex-shrink: 0; padding: 0;
            }
            .tile-btn:hover { transform: scale(1.15); }
            .tile-btn-edit { top: -6px; left: -6px; background: #007bff; font-size: 12px; } 
            .tile-btn-delete { top: -6px; right: -6px; background: #dc3545; font-size: 14px; line-height: 1; } 

            /* MODALS */
            .modal-overlay { position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0,0,0,0.85); z-index: 1000; display: flex; justify-content: center; align-items: center; backdrop-filter: blur(5px); opacity: 0; visibility: hidden; transition: opacity 0.3s ease, visibility 0.3s ease; }
            .modal-overlay.active { opacity: 1; visibility: visible; }
            .modal-content { background: #151618; width: 90%; max-width: 1200px; height: 85%; border-radius: 12px; border: 1px solid #444; display: flex; flex-direction: column; overflow: hidden; box-shadow: 0 0 40px rgba(0,0,0,0.8); transform: scale(0.95); transition: transform 0.3s ease; }
            .modal-overlay.active .modal-content { transform: scale(1); }
            .modal-header { padding: 20px; border-bottom: 1px solid #333; display: flex; justify-content: space-between; align-items: center; background: #1a1b1d; }
            .modal-title { font-size: 1.5em; color: #fff; margin: 0; }
            
            .modal-close { 
                background: transparent; border: 1px solid #444; color: #888; font-size: 26px; 
                width: 36px; height: 36px; border-radius: 50%; padding: 0; 
                cursor: pointer; transition: 0.2s; display: flex; align-items: center; justify-content: center; line-height: 1;
            }
            .modal-close:hover { background: #333; color: #fff; border-color: #fff; }
            .modal-body { flex: 1; overflow-y: auto; padding: 20px; background: #0f1011; }
            .empty-cart-msg { text-align: center; color: #666; font-size: 1.2em; margin-top: 50px; }
            
            .import-modal-content { background: #121212; border: 1px solid #333; max-width: 800px; width: 90%; border-radius: 8px; }
            .import-input-group { margin-bottom: 20px; }
            .import-label { display: block; font-size: 12px; color: #888; margin-bottom: 8px; text-transform: uppercase; }
            .import-textarea { width: 100%; height: 80px; background: #080808; border: 1px solid #333; border-radius: 4px; color: #ccc; padding: 10px; font-family: monospace; resize: none; box-sizing: border-box; }
            .import-textarea:focus { border-color: #0070dd; outline: none; }
            .save-btn { width: 100%; background: #0070dd; color: white; border: none; padding: 12px; font-weight: bold; font-size: 14px; border-radius: 4px; cursor: pointer; text-transform: uppercase; transition: 0.2s; }
            .save-btn:hover { background: #005bb5; }

            .details-modal-content { max-width: 900px; height: auto; max-height: 80%; }
            .details-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 30px; }
            .prof-col { display: flex; flex-direction: column; gap: 15px; }
            .prof-title-wrapper { display: flex; align-items: center; gap: 10px; border-bottom: 1px solid #333; padding-bottom: 8px; margin-bottom: 10px; }
            .prof-icon { width: 32px; height: 32px; border-radius: 4px; border: 1px solid #444; }
            .prof-title { color: #ffd700; font-size: 1.1em; font-weight: bold; text-transform: uppercase; }
            .prof-row { display: flex; flex-direction: column; gap: 5px; margin-bottom: 12px; }
            .prof-header { display: flex; justify-content: space-between; font-size: 14px; color: #fff; }
            .skill-bar-bg { width: 100%; height: 10px; background: #333; border-radius: 5px; overflow: hidden; border: 1px solid #444; }
            .skill-bar-fill { height: 100%; background: linear-gradient(90deg, #0070dd, #a335ee); width: 0%; border-radius: 5px; transition: width 0.5s ease; }

            /* MAIN LIST ITEMS */
            .item-card { background: #1a1b1d; border-radius: 8px; margin-bottom: 12px; border: 1px solid #2a2b2e; transition: all 0.2s ease; }
            .item-card:hover { border-color: #444; background: #202124; }
            .item-card.active { border-color: #ffd700 !important; box-shadow: 0 0 15px rgba(255, 215, 0, 0.15); }
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
            
            /* LOAD MORE */
            .load-more-container { display: flex; justify-content: center; margin-top: 30px; width: 100%; }

            /* CRAFTER BADGE (TASK 2: Removed specific coloring, now inherits info-badge gray) */
            /* .crafter-badge { } */
            /* --- ОНОВЛЕНИЙ СТИЛЬ ПЛИТОЧОК (Issue 4: Темне золото) --- */
            .char-tile {
                display: flex; align-items: center; 
                background: linear-gradient(145deg, #2b2515, #1a1a1a); /* Темний золотий відтінок */
                border: 1px solid #7c6a28; /* Золота рамка */
                border-radius: 30px;
                padding: 6px 10px 6px 6px; gap: 10px;
                position: relative; transition: all 0.2s; min-height: 42px;
                margin-bottom: 10px;
                box-shadow: 0 4px 6px rgba(0,0,0,0.3);
            }
            .char-tile:hover { 
                background: linear-gradient(145deg, #3d341a, #222);
                border-color: #ffd700; 
                box-shadow: 0 0 15px rgba(255, 215, 0, 0.2); 
            }
            .char-name { font-weight: bold; color: #e6c85e; font-size: 14px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

            /* --- ВИПРАВЛЕННЯ ІМПОРТ МОДАЛКИ (Issue 3: Хрестик праворуч) --- */
            .import-modal-header {
                display: flex;
                justify-content: space-between; /* Розсовує заголовок і хрестик по краях */
                align-items: center;
                padding: 15px 20px;
                background: #1a1b1d;
                border-bottom: 1px solid #333;
                width: 100%;
                box-sizing: border-box; 
            }
            .import-modal-title { font-size: 1.2em; color: #fff; font-weight: bold; letter-spacing: 1px; margin: 0; }

            /* --- КОШИК (Issue 2: Ширина + Видимість інпутів) --- */
            #cartModal .modal-content {
                max-width: 1400px; /* Широкий кошик */
                width: 95%;
            }

            /* Приховуємо ТІЛЬКИ галочку всередині кошика */
            #cartBody .check-input {
                display: none !important; 
            }
            
            /* (Опціонально) Трохи посунути поле кількості в кошику, щоб виглядало гарно без галочки */
            #cartBody .qty-input {
                margin-right: 0; 
            }
            /* --- 1. ПОВЕРТАЄМО СИНІЙ СТИЛЬ ПЛИТОЧОК ПЕРСОНАЖІВ (як було спочатку) --- */
            .char-tile {
                display: flex; align-items: center; background: #1a1b1d;
                border: 2px solid #0070dd; /* Синя рамка */
                border-radius: 30px;
                padding: 6px 10px 6px 6px; gap: 10px;
                position: relative; transition: all 0.2s; min-height: 42px;
                margin-bottom: 10px;
                box-shadow: none;
            }
            .char-tile:hover { 
                background: #222; 
                border-color: #0070dd;
                box-shadow: 0 0 10px rgba(0, 112, 221, 0.3); 
            }
            .char-name { font-weight: bold; color: #fff; font-size: 14px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

            /* --- 2. НОВИЙ СТИЛЬ ДЛЯ КРАФТЕРА В ЛОТІ (Золотий, як просили) --- */
            /* Це застосується до елемента, виділеного червоним на скріншоті */
            .info-badge.crafter-badge {
                background: linear-gradient(145deg, #2b2515, #1a1a1a); /* Темне золото фон */
                border: 1px solid #7c6a28; /* Золота рамка */
                color: #ffd700; /* Яскравий золотий текст */
                text-shadow: 0 1px 2px rgba(0,0,0,0.8);
                box-shadow: 0 2px 5px rgba(0,0,0,0.4);
                font-weight: bold;
            }
            /* --- СТИЛІ ДЛЯ ІКОНОК ПРОФЕСІЙ В ПЛИТЦІ --- */
            .char-profs {
                display: flex;
                align-items: center;
                gap: -5px; /* Легке перекриття іконок виглядає стильно, або поставте 5px для відступу */
                margin-left: auto; /* Притискає блок праворуч */
                margin-right: 25px; /* Відступ, щоб не налізти на кнопку видалення */
                z-index: 5;
            }
            .prof-mini-icon {
                width: 32px;
                height: 32px;
                border-radius: 50%;
                border: 2px solid #ffd700; /* Золота рамка */
                background-color: #111;
                object-fit: cover;
                box-shadow: 0 2px 5px rgba(0,0,0,0.5);
                transition: transform 0.2s;
            }
            .prof-mini-icon:hover {
                transform: scale(1.1);
                z-index: 10;
            }        
        </style>
    </head>
    <body>
        <div id="topRightSection">
            <div id="btnAddCharWrapper" class="add-char-btn" onclick="openImportModal()">
                <div class="add-char-circle">+</div>
                <div class="add-char-label">Add your first character</div>
            </div>

            <div id="charMenuContainer" class="char-menu-container" style="display:none;">
                <button id="btnCharMenu" class="btn-char-menu">Characters Info</button>
                <div id="charDropdown" class="char-dropdown">
                    <div id="charList"></div>
                    <button class="btn-add-new-char" onclick="openImportModal()">+ Add Character</button>
                </div>
            </div>
        </div>

        <div class="container">
            <div class="header-container">
                <h1>💎 WoW Decor Scanner</h1>
                <div class="update-time">Оновлено: ${updateTime}</div>
                <div class="controls-row">
                    <div class="search-wrapper">
                        <input type="text" id="smartSearchInput" placeholder="Назва, професія або патч...">
                        <div class="stats-wrapper">
                            <div class="stats-icon info-btn">i</div>
                            <div class="stats-tooltip">
                                <div class="stats-title">Average / Lumber</div>
                                ${expTooltipHtml}
                            </div>
                        </div>
                    </div>
                    <div class="buttons-group">
                        <div id="btnReset" class="stats-icon btn-reset" title="Очистити все">↻</div>
                        <button id="btnOpenCart" class="btn-cart-rect" title="Відкрити кошик">🛒 Cart</button>
                        <button class="btn-import-addon">Lumber Import</button>
                        <button class="btn-import">Reagents Import</button>
                    </div>
                </div>
            </div>

            <div id="list"></div>
            <div class="load-more-container"><button id="btnLoadMore" class="btn-load-more">Показати ще</button></div>
        </div>
        
        <div id="cartModal" class="modal-overlay">
            <div class="modal-content">
                <div class="modal-header">
                    <h2 class="modal-title">📦 Обрані предмети (Cart)</h2>
                    <button id="btnCloseCart" class="modal-close">×</button>
                </div>
                <div id="cartBody" class="modal-body"></div>
            </div>
        </div>

        <div id="importModal" class="modal-overlay">
            <div class="import-modal-content">
                <div class="import-modal-header">
                    <div class="import-modal-title">IMPORT CHARACTER</div>
                    <button id="btnCloseImport" class="modal-close">×</button>
                </div>
                <div class="modal-body" style="padding: 20px;">
                    <div class="import-input-group">
                        <label class="import-label">PROFESSION 1 (PASTE JSON)</label>
                        <textarea id="prof1Input" class="import-textarea"></textarea>
                    </div>
                    <div class="import-input-group">
                        <label class="import-label">PROFESSION 2 (PASTE JSON)</label>
                        <textarea id="prof2Input" class="import-textarea"></textarea>
                    </div>
                    <input type="hidden" id="editCharId" value="">
                    <button class="save-btn" onclick="saveCharacter()">SAVE CHARACTER</button>
                </div>
            </div>
        </div>

        <div id="charDetailsModal" class="modal-overlay">
            <div class="modal-content details-modal-content">
                <div class="modal-header">
                    <h2 id="detailsModalTitle" class="modal-title">Character Details</h2>
                    <button id="btnCloseDetails" class="modal-close">×</button>
                </div>
                <div id="charDetailsBody" class="modal-body" style="padding: 20px;"></div>
            </div>
        </div>

        <script>
            const ALL_DATA = ${jsonPayload};
            const SKILL_REQS = ${jsonSkillReq};
            let activeData = ALL_DATA; 
            let currentIndex = 0;
            const ITEMS_PER_PAGE = 20;
            let activeCharts = {};
            let chartRanges = {}; 
            
            let savedState = JSON.parse(localStorage.getItem('wowScnr_state')) || {};
            let charsList = JSON.parse(localStorage.getItem('wowScnr_chars_list')) || [];
            
            // Optimization: Parse all characters once on load/change
            let parsedChars = [];

            // EXPANSION MAPPING: ItemDB Name -> JSON Key / Import Name
            const EXPANSION_MAP = {
                "Burning Crusade": "Outland",
                "Wrath of the Lich King": "Northrend",
                "Cataclysm": "Cataclysm",
                "Mists of Pandaria": "Pandaria",
                "Warlords of Draenor": "Draenor",
                "Legion": "Legion",
                "Battle for Azeroth": "Zandalari", 
                "Shadowlands": "Shadowlands",
                "Dragonflight": "Dragon Isles",
                "The War Within": "Khaz Algari",
                "Vanilla": "Classic" 
            };

            function saveToStorage() { localStorage.setItem('wowScnr_state', JSON.stringify(savedState)); }
            function saveCharsToStorage() { 
                localStorage.setItem('wowScnr_chars_list', JSON.stringify(charsList)); 
                reparseAllCharacters();
                updateTopRightSection();
                // TASK 3: Dynamically update badges on existing list
                updateVisibleCrafterBadges();
            }

            function reparseAllCharacters() {
                parsedChars = charsList.map(char => {
                    return {
                        name: char.name,
                        p1: extractSkillData(char.p1),
                        p2: extractSkillData(char.p2)
                    };
                });
            }

            // Recursive parser (reused for both display and matching)
            function extractSkillData(str) {
                if (!str) return null;
                let root;
                try { root = JSON.parse(str); } catch(e) { return null; }

                let title = "Unknown Profession";
                let skillsFound = [];

                function traverse(node) {
                    if (typeof node !== 'object' || node === null) return;
                    if (node.name && (node.skill !== undefined || node.value !== undefined)) {
                        const n = node.name.toLowerCase();
                        if(title === "Unknown Profession") {
                            if(n.includes("inscription")) title = "Inscription";
                            else if(n.includes("alchemy")) title = "Alchemy";
                            else if(n.includes("jewelcrafting")) title = "Jewelcrafting";
                            else if(n.includes("blacksmithing")) title = "Blacksmithing";
                            else if(n.includes("enchanting")) title = "Enchanting";
                            else if(n.includes("engineering")) title = "Engineering";
                            else if(n.includes("leatherworking")) title = "Leatherworking";
                            else if(n.includes("tailoring")) title = "Tailoring";
                        }
                        
                        let current = node.skill !== undefined ? node.skill : node.value;
                        let max = node.maxSkill !== undefined ? node.maxSkill : 
                                  (node.max !== undefined ? node.max : 100);
                        
                        skillsFound.push({ name: node.name, skill: current, max: max });
                    }
                    Object.keys(node).forEach(key => traverse(node[key]));
                }
                traverse(root);
                return { title, skills: skillsFound };
            }

            function findCrafters(itemExp, itemProf) {
                if (!itemExp || !itemProf || parsedChars.length === 0) return null;
                
                const profObj = SKILL_REQS.find(p => p[itemProf]);
                if (!profObj) return null;
                
                const mappedExp = EXPANSION_MAP[itemExp] || itemExp;
                const reqArray = profObj[itemProf];
                
                const expReqObj = reqArray.find(r => r[mappedExp] !== undefined);
                if (!expReqObj) return null;
                
                const requiredSkill = expReqObj[mappedExp];
                
                let validCrafters = [];
                
                parsedChars.forEach(char => {
                    [char.p1, char.p2].forEach(pData => {
                        if (!pData) return;
                        if (pData.title === itemProf) {
                            const skillEntry = pData.skills.find(s => s.name.includes(mappedExp));
                            if (skillEntry) {
                                if (skillEntry.skill >= requiredSkill) {
                                    validCrafters.push(char.name);
                                }
                            }
                        }
                    });
                });
                
                return validCrafters.length > 0 ? validCrafters.join(', ') : null;
            }

            // TASK 3: Function to update badges dynamically without full re-render
            function updateVisibleCrafterBadges() {
                const cards = document.querySelectorAll('.item-card');
                cards.forEach(card => {
                    const itemId = card.dataset.id;
                    const itemData = ALL_DATA.find(i => i.itemId == itemId);
                    if (itemData) {
                        const crafterName = findCrafters(itemData.exp, itemData.prof);
                        const leftCol = card.querySelector('.main-row-left');
                        
                        // Remove existing
                        const existingBadge = leftCol.querySelector('.crafter-badge');
                        if (existingBadge) existingBadge.remove();

                        // Add new if crafter exists
                        if (crafterName) {
                            const badge = document.createElement('div');
                            badge.className = 'info-badge crafter-badge';
                            badge.textContent = crafterName;
                            // Insert before other badges (after name)
                            const expBadge = leftCol.querySelector('.info-badge:not(.crafter-badge)');
                            if (expBadge) {
                                leftCol.insertBefore(badge, expBadge);
                            } else {
                                leftCol.appendChild(badge);
                            }
                        }
                    }
                });
            }

            document.addEventListener('change', (e) => {
                if (e.target.classList.contains('check-input')) {
                    const card = e.target.closest('.item-card');
                    const itemId = card.dataset.id;
                    if (!savedState[itemId]) savedState[itemId] = {};
                    savedState[itemId].checked = e.target.checked;
                    saveToStorage();
                }
            });

            document.addEventListener('input', (e) => {
                if (e.target.classList.contains('qty-input')) {
                    const card = e.target.closest('.item-card');
                    const itemId = card.dataset.id;
                    const val = parseInt(e.target.value);
                    if (!savedState[itemId]) savedState[itemId] = {};
                    savedState[itemId].qty = isNaN(val) ? 0 : val;
                    saveToStorage();
                }
            });

            function toggleDetails(card, itemId) {
                if (card.closest('#cartBody')) return;
                card.classList.toggle('active');
                if (card.classList.contains('active')) setTimeout(() => drawChart(itemId), 50);
            }

            // --- CHARACTERS LOGIC ---
            function updateTopRightSection() {
                const addWrapper = document.getElementById('btnAddCharWrapper');
                const menuContainer = document.getElementById('charMenuContainer');
                
                if (charsList.length === 0) {
                    addWrapper.style.display = 'flex';
                    menuContainer.style.display = 'none';
                } else {
                    addWrapper.style.display = 'none';
                    menuContainer.style.display = 'block';
                    renderCharList();
                }
            }

            document.getElementById('btnCharMenu').addEventListener('click', (e) => {
                e.stopPropagation();
                document.getElementById('charDropdown').classList.toggle('active');
            });
            
            document.addEventListener('click', (e) => {
                const dropdown = document.getElementById('charDropdown');
                const btn = document.getElementById('btnCharMenu');
                if (!dropdown.contains(e.target) && e.target !== btn) {
                    dropdown.classList.remove('active');
                }
            });

            function openImportModal(editIndex = -1) {
                document.getElementById('editCharId').value = editIndex;
                if (editIndex >= 0 && charsList[editIndex]) {
                    const char = charsList[editIndex];
                    document.getElementById('prof1Input').value = char.p1 || "";
                    document.getElementById('prof2Input').value = char.p2 || "";
                } else {
                    document.getElementById('prof1Input').value = "";
                    document.getElementById('prof2Input').value = "";
                }
                document.getElementById('importModal').classList.add('active');
            }
            
            document.getElementById('btnCloseImport').addEventListener('click', () => {
                document.getElementById('importModal').classList.remove('active');
            });

            function saveCharacter() {
                const p1Str = document.getElementById('prof1Input').value;
                const p2Str = document.getElementById('prof2Input').value;
                const editId = parseInt(document.getElementById('editCharId').value);
                
                let name = "Unknown";
                let realm = "Unknown";
                let charClass = "unknown"; 

                function parseMeta(str) {
                    try {
                        const obj = JSON.parse(str);
                        if(obj.character) name = obj.character;
                        if(obj.realm) realm = obj.realm;
                        if(obj.class) charClass = obj.class.toLowerCase().replace(/\\s/g, '');
                    } catch(e) {}
                }
                parseMeta(p1Str);
                parseMeta(p2Str);

                if ((p1Str || p2Str) && name === "Unknown") name = "Imported Char";

                const newChar = { name, realm, class: charClass, p1: p1Str, p2: p2Str };

                if (editId >= 0) {
                    charsList[editId] = newChar;
                } else {
                    charsList.push(newChar);
                }
                
                saveCharsToStorage();
                document.getElementById('importModal').classList.remove('active');
            }

            function deleteCharacter(index) {
                if(confirm("Delete this character?")) {
                    charsList.splice(index, 1);
                    saveCharsToStorage();
                }
            }

            function openCharDetails(index) {
                const char = charsList[index];
                if (!char) return;

                document.getElementById('detailsModalTitle').innerText = \`\${char.name} (\${char.realm})\`;
                const body = document.getElementById('charDetailsBody');
                
                function buildHtmlColumn(data, defaultTitle) {
                    if (!data || data.skills.length === 0) {
                        return \`<div class="prof-col"><div class="prof-title-wrapper"><span class="prof-title">\${defaultTitle}</span></div><div style="color:#666">No skill data found</div></div>\`;
                    }
                    
                    const iconName = data.title.toLowerCase().replace(/\\s+/g, '');
                    const iconUrl = \`prof_class_icons/\${iconName}.jpg\`;
                    
                    let rows = '';
                    data.skills.forEach(s => {
                        const pct = Math.min(100, (s.skill / s.max) * 100);
                        rows += \`
                            <div class="prof-row">
                                <div class="prof-header"><span>\${s.name}</span><span>\${s.skill} / \${s.max}</span></div>
                                <div class="skill-bar-bg"><div class="skill-bar-fill" style="width:\${pct}%"></div></div>
                            </div>
                        \`;
                    });
                    
                    return \`
                        <div class="prof-col">
                            <div class="prof-title-wrapper">
                                <img src="\${iconUrl}" class="prof-icon" onerror="this.style.display='none'">
                                <span class="prof-title">\${data.title}</span>
                            </div>
                            \${rows}
                        </div>\`;
                }

                const data1 = extractSkillData(char.p1);
                const data2 = extractSkillData(char.p2);

                const leftHtml = buildHtmlColumn(data1, "Profession 1");
                const rightHtml = buildHtmlColumn(data2, "Profession 2");

                body.innerHTML = \`<div class="details-grid">\${leftHtml}\${rightHtml}</div>\`;
                document.getElementById('charDetailsModal').classList.add('active');
            }
            
            document.getElementById('btnCloseDetails').addEventListener('click', () => {
                document.getElementById('charDetailsModal').classList.remove('active');
            });

            function renderCharList() {
                const container = document.getElementById('charList');
                container.innerHTML = '';
                
                charsList.forEach(function(char, index) {
                    // 1. Логіка іконки класу (ліворуч)
                    const iconName = char.class ? char.class.toLowerCase().replace(/\s+/g, '') : "unknown";
                    const iconUrl = "prof_class_icons/" + iconName + ".jpg";
                    
                    // 2. Логіка іконок професій (праворуч)
                    const p1Data = extractSkillData(char.p1);
                    const p2Data = extractSkillData(char.p2);
                    
                    let profsHtml = '<div class="char-profs">';
                    
                    [p1Data, p2Data].forEach(function(p) {
                        if (p && p.title && p.title !== "Unknown Profession") {
                            // Перетворюємо "Mining" -> "mining", "Blacksmithing" -> "blacksmithing"
                            const pName = p.title.toLowerCase().replace(/\s+/g, '');
                            const pUrl = "prof_class_icons/" + pName + ".jpg";
                            
                            // Додаємо картинку. onerror сховає її, якщо картинки немає
                            profsHtml += '<img src="' + pUrl + '" class="prof-mini-icon" title="' + p.title + '" onerror="this.style.display=\'none\'">';
                        }
                    });
                    profsHtml += '</div>';

                    // 3. Формуємо плитку
                    const div = document.createElement('div');
                    div.className = 'char-tile';
                    div.innerHTML = 
                        '<button class="tile-btn tile-btn-edit" onclick="openCharDetails(' + index + ')">✎</button>' +
                        '<button class="tile-btn tile-btn-delete" onclick="deleteCharacter(' + index + ')">×</button>' +
                        '<div class="char-avatar" style="background-image: url(\'' + iconUrl + '\');"></div>' +
                        '<div class="char-info">' +
                            '<div class="char-name">' + char.name + '</div>' +
                            '<div class="char-realm">' + char.realm + '</div>' +
                        '</div>' +
                        profsHtml; // Вставляємо блок професій
                    
                    container.appendChild(div);
                });
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
                const itemData = ALL_DATA.find(i => i.itemId == itemId);
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
                            pointRadius: dataPoints.length < 2 ? 5 : 0,
                            pointHoverRadius: 6,
                            pointBackgroundColor: '#fff'
                        }]
                    },
                    options: {
                        animation: false, 
                        responsive: true,
                        maintainAspectRatio: false,
                        interaction: { mode: 'index', intersect: false },
                        plugins: { legend: { display: false }, tooltip: { backgroundColor: 'rgba(0,0,0,0.8)', titleColor: '#fff', bodyColor: '#0070dd', displayColors: false, callbacks: { label: (c) => c.parsed.y.toLocaleString() + ' g' } } },
                        scales: { x: { display: false }, y: { display: false } }
                    }
                });
            }

            function copyName(el) {
                const text = el.firstChild.textContent;
                navigator.clipboard.writeText(text).then(() => {
                    el.classList.add('copied');
                    setTimeout(() => el.classList.remove('copied'), 1500);
                });
            }

            function handleReset() {
                if(!confirm("Очистити вибір предметів? (Персонажі залишаться)")) return;
                
                // Очищаємо тільки стан вибору
                localStorage.removeItem('wowScnr_state');
                
                // НЕ видаляємо персонажів
                // localStorage.removeItem('wowScnr_chars_list'); 
                
                savedState = {};
                
                // НЕ обнуляємо список персонажів у пам'яті
                // charsList = []; 
                // reparseAllCharacters();

                // Скидаємо UI
                document.querySelectorAll('.check-input').forEach(el => el.checked = false);
                document.querySelectorAll('.qty-input').forEach(el => el.value = '');
                document.getElementById('smartSearchInput').value = '';
                
                activeData = ALL_DATA;
                currentIndex = 0;
                document.getElementById('list').innerHTML = '';
                loadMore();
                
                // Оновлюємо бейджі, бо крафтери залишились
                updateTopRightSection();
                updateVisibleCrafterBadges();
            }

            function openCart() {
                const modal = document.getElementById('cartModal');
                const body = document.getElementById('cartBody');
                body.innerHTML = '';
                const checkedIds = Object.keys(savedState).filter(id => savedState[id] && savedState[id].checked);
                if (checkedIds.length === 0) {
                    body.innerHTML = '<div class="empty-cart-msg">Кошик порожній.</div>';
                } else {
                    const cartItems = ALL_DATA.filter(item => checkedIds.includes(item.itemId.toString()));
                    body.innerHTML = cartItems.map(createCartItemHTML).join('');
                }
                modal.classList.add('active');
            }

            function closeCart() {
                document.getElementById('cartModal').classList.remove('active');
                document.getElementById('list').innerHTML = '';
                currentIndex = 0;
                loadMore();
                updateVisibleCrafterBadges();
            }

            function handleAddonImport(e) {
                const btn = e.currentTarget;
                const checkedIds = Object.keys(savedState).filter(id => savedState[id] && savedState[id].checked);
                if (checkedIds.length === 0) return alert("Вибери предмети!");
                
                let summary = {}; 
                checkedIds.forEach(id => {
                    const itemData = ALL_DATA.find(i => i.itemId == id);
                    if (!itemData) return;
                    const count = savedState[id].qty || 0;
                    
                    if (count > 0) {
                        const exp = itemData.exp; 
                        const lumberReq = itemData.craftQty || 0;
                        const totalLumber = count * lumberReq;
                        
                        // Додаємо навіть якщо не вимагає ламберу, але є в списку (опціонально, але для адону безпечніше)
                        if (exp) {
                            if (!summary[exp]) summary[exp] = { totalLumber: 0, items: [] };
                            summary[exp].totalLumber += totalLumber;
                            
                            const crafter = findCrafters(itemData.exp, itemData.prof) || "";
                            
                            summary[exp].items.push({ 
                                name: itemData.name, 
                                price: itemData.bestPrice, 
                                count: count,
                                crafter: crafter,
                                craftCost: Math.floor(itemData.craftCost),
                                prof: itemData.prof // <--- ДОДАНО ПРОФЕСІЮ ТУТ
                            });
                        }
                    }
                });
                
                const payload = Object.keys(summary).map(exp => ({ 
                    "Exp": exp, 
                    "craftQty": summary[exp].totalLumber, 
                    "items": summary[exp].items 
                }));
                
                if (payload.length === 0) return alert("Помилка даних або не введено кількість.");
                visualCopy(btn, JSON.stringify(payload));
            }

            function handleReagentsImport(e) {
                const btn = e.currentTarget;
                const checkedIds = Object.keys(savedState).filter(id => savedState[id] && savedState[id].checked);
                if (checkedIds.length === 0) return alert("Вибери предмети!");
                let reagentsMap = {};
                let hasItems = false;
                checkedIds.forEach(id => {
                    const itemData = ALL_DATA.find(i => i.itemId == id);
                    if (!itemData) return;
                    const count = savedState[id].qty || 0;
                    if (count > 0) {
                        hasItems = true;
                        if (itemData.recipeRaw && Array.isArray(itemData.recipeRaw)) {
                            itemData.recipeRaw.forEach(r => {
                                if (!reagentsMap[r.name]) reagentsMap[r.name] = 0;
                                reagentsMap[r.name] += (r.count * count);
                            });
                        }
                    }
                });
                if (!hasItems) return alert("Введи кількість!");
                const listString = Object.entries(reagentsMap).map(([n, q]) => \`\${n} x\${q}\`).join('\\n');
                visualCopy(btn, listString);
            }

            function visualCopy(btn, text) {
                // 1. Якщо таймер вже йде (швидкий клік), скасовуємо його, щоб не було глюків
                if (btn.dataset.timer) {
                    clearTimeout(btn.dataset.timer);
                }

                // 2. Жорстко визначаємо, який текст має повернутись
                let defaultLabel = "Import"; 
                
                if (btn.classList.contains('btn-import')) {
                    defaultLabel = "Reagents Import";
                } else if (btn.classList.contains('btn-import-addon')) {
                    defaultLabel = "Lumber Import";
                } else if (btn.id === 'btnOpenCart') {
                    defaultLabel = "🛒 Cart";
                }

                // 3. Копіюємо текст
                navigator.clipboard.writeText(text).catch(err => console.error(err));

                // 4. Ставимо статус "Успіх"
                btn.innerText = "Скопійовано!";
                btn.style.backgroundColor = "#a335ee"; // Фіолетовий

                // 5. Запускаємо новий таймер відновлення
                btn.dataset.timer = setTimeout(() => {
                    btn.innerText = defaultLabel; // Повертаємо правильний текст
                    btn.style.backgroundColor = ""; // ВАЖЛИВО: Просто скидаємо колір, щоб повернувся ваш CSS (зелений/синій)
                    delete btn.dataset.timer;
                }, 2000);
            }

            function createItemHTML(item) { return generateItemHtmlString(item, true); }
            function createCartItemHTML(item) { return generateItemHtmlString(item, false); }

            function generateItemHtmlString(item, expandale) {
                const recipeJson = JSON.stringify(item.recipeRaw).replace(/"/g, '&quot;');
                const saved = savedState[item.itemId] || {};
                const isChecked = saved.checked ? 'checked' : '';
                const qtyVal = saved.qty && saved.qty > 0 ? saved.qty : '';
                
                // Logic to check crafters
                const crafterName = findCrafters(item.exp, item.prof);
                // Apply same style as info-badge but keep text yellow
                const crafterHtml = crafterName ? \`<div class="info-badge crafter-badge">\${crafterName}</div>\` : '';

                let recipeHtml = item.reagentsList && item.reagentsList.length > 0 ? '<ul class="recipe-list">' + item.reagentsList.map(r => \`<li><div class="reag-left"><span style="color:#ffd700;font-weight:bold">\${r.count}x</span> <img src="\${r.icon}" class="reag-icon"> <span>\${r.name}</span></div><div class="reag-right">\${r.price < 10 ? parseFloat(r.price.toFixed(2)) : Math.floor(r.price).toLocaleString()} <img src="https://wow.zamimg.com/images/wow/icons/large/inv_misc_coin_01.jpg" class="coin-xs"></div></li>\`).join('') + '</ul>' : '<div style="color:#555">No recipe</div>';
                const top10Html = item.top10.map(l => \`<div class="server-row"><span>\${l.r}</span><span class="server-price">\${l.p.toLocaleString()} <img src="https://wow.zamimg.com/images/wow/icons/large/inv_misc_coin_01.jpg" class="coin-xs"></span></div>\`).join('');
                let lumberClass = item.lumberPrice > 0 ? "positive" : (item.lumberPrice > -999999 ? "negative" : "neutral");
                const dispLumber = item.lumberPrice > -999999 ? Math.floor(item.lumberPrice).toLocaleString() : 'N/A';
                const toggleAttr = expandale ? \`onclick="toggleDetails(this.closest('.item-card'), \${item.itemId})"\` : '';

                // Note: onclick="copyName(this)" simplifies the escaping issue
                return \`<div class="item-card" data-id="\${item.itemId}" data-recipe="\${recipeJson}" data-exp="\${item.exp || ''}" data-lumber="\${item.craftQty || 0}">
                    <div class="main-row">
                        <div class="main-row-left">
                            <div class="col-icon"><img src="\${item.icon}"></div>
                            <div class="col-name"><div class="name-text" onclick="copyName(this)">\${item.name}<span class="copy-tooltip">Скопійовано!</span></div></div>
                            \${crafterHtml}
                            \${item.exp ? \`<div class="info-badge">\${item.exp}</div>\` : ''}
                            \${item.prof ? \`<div class="info-badge">\${item.prof}</div>\` : ''}
                        </div>
                        <div class="main-row-right">
                            <div class="col-lumber info-badge \${lumberClass}" \${toggleAttr}><span style="margin-right:5px;text-transform:uppercase;font-size:0.8em">1 Lumber = </span><span class="val">\${dispLumber}</span><img src="https://wow.zamimg.com/images/wow/icons/large/inv_misc_coin_01.jpg" class="coin-xs" style="margin-left:4px"></div>
                            <div class="col-price" \${toggleAttr}><span>\${Math.floor(item.bestPrice).toLocaleString()}</span><img src="https://wow.zamimg.com/images/wow/icons/large/inv_misc_coin_01.jpg" style="width:18px;border-radius:50%"></div>
                            <div class="col-inputs"><input type="number" class="qty-input" placeholder="0" min="0" value="\${qtyVal}"><input type="checkbox" class="check-input" \${isChecked}></div>
                        </div>
                    </div>
                    \${expandale ? \`<div class="details-row"><div class="details-content"><div class="details-left"><div class="chart-wrapper"><div class="chart-controls"><button class="chart-btn" onclick="setChartRange(this, '\${item.itemId}', '1w')">1W</button><button class="chart-btn active" onclick="setChartRange(this, '\${item.itemId}', '1m')">1M</button><button class="chart-btn" onclick="setChartRange(this, '\${item.itemId}', '6m')">6M</button><button class="chart-btn" onclick="setChartRange(this, '\${item.itemId}', '1y')">1Y</button></div><canvas id="chart-\${item.itemId}"></canvas></div><div class="reagents-block"><div style="display:flex;justify-content:space-between;margin-bottom:10px"><h4>Recipe Cost</h4><span style="color:#f44336;font-weight:bold">Total: -\${Math.floor(item.craftCost).toLocaleString()} <img src="https://wow.zamimg.com/images/wow/icons/large/inv_misc_coin_01.jpg" class="coin-xs"></span></div>\${recipeHtml}\${item.craftQty > 0 ? \`<div style="margin-top:10px;color:#4caf50;text-align:center;background:#1a3b1a;padding:5px;border-radius:4px">Requires: <b>\${item.craftQty}</b> Lumber</div>\` : ''}</div></div><div class="details-right"><h4>Cheapest Realms (Top 10)</h4>\${top10Html}</div></div></div>\` : ''}
                </div>\`;
            }

            function loadMore() {
                const list = document.getElementById('list');
                const btn = document.getElementById('btnLoadMore');
                const nextItems = activeData.slice(currentIndex, currentIndex + ITEMS_PER_PAGE);
                if (nextItems.length > 0) { list.insertAdjacentHTML('beforeend', nextItems.map(createItemHTML).join('')); currentIndex += nextItems.length; }
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
                activeData = filtered; currentIndex = 0; document.getElementById('list').innerHTML = ''; loadMore();
            }

            document.addEventListener('DOMContentLoaded', () => {
                reparseAllCharacters(); // Parse on load
                loadMore();
                updateTopRightSection();
                document.getElementById('btnLoadMore').addEventListener('click', loadMore);
                document.getElementById('smartSearchInput').addEventListener('input', handleSearch);
                document.querySelector('.btn-import-addon').addEventListener('click', handleAddonImport);
                document.querySelector('.btn-import').addEventListener('click', handleReagentsImport);
                document.getElementById('btnOpenCart').addEventListener('click', openCart);
                document.getElementById('btnCloseCart').addEventListener('click', closeCart);
                document.getElementById('cartModal').addEventListener('click', (e) => { if (e.target.id === 'cartModal') closeCart(); });
                document.getElementById('btnReset').addEventListener('click', handleReset);
                document.getElementById('importModal').addEventListener('click', (e) => { if (e.target.id === 'importModal') document.getElementById('importModal').classList.remove('active'); });
                document.getElementById('charDetailsModal').addEventListener('click', (e) => { if (e.target.id === 'charDetailsModal') document.getElementById('charDetailsModal').classList.remove('active'); });
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