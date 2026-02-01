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
    console.log("📝 Генерую звіт (Fix Price Logic)...");
    
    const FAVICON_NAME = 'homestone.jpg'; 

    if (!fs.existsSync('public')) fs.mkdirSync('public');
    if (fs.existsSync('import.js')) fs.copyFileSync('import.js', 'public/import.js');
    if (fs.existsSync(FAVICON_NAME)) {
        fs.copyFileSync(FAVICON_NAME, path.join('public', FAVICON_NAME));
    }

    ['header_bg.jpg', 'body_bg.jpg', 'footer_bg.jpg'].forEach(file => {
        if (fs.existsSync(file)) {
            fs.copyFileSync(file, path.join('public', file));
        }
    });

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
    // Створюємо повну базу іконок для історії
    const fullItemDb = calculatedItems.map(i => ({ name: i.name, icon: i.icon }));
    const jsonFullDb = JSON.stringify(fullItemDb);
    // ----------------------
    const jsonSkillReq = JSON.stringify(skillNeededData);
    const updateTime = new Date().toLocaleString("uk-UA", { timeZone: "Europe/Kyiv" });

    // --- 2. HTML Template ---
    const html = `
    <!DOCTYPE html>
    <html lang="uk">
    <head>
        <script async src="https://www.googletagmanager.com/gtag/js?id=G-QYCN5HCRXY"></script>
        <script>
        window.dataLayer = window.dataLayer || [];
        function gtag(){dataLayer.push(arguments);}
        gtag('js', new Date());

        gtag('config', 'G-QYCN5HCRXY');
        </script>
        
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
            
            /* NEW: TOP LEFT SECTION (SALES HISTORY) */
            #topLeftSection { position: absolute; top: 20px; left: 30px; z-index: 100; }
            
            .btn-history-login {
                background: linear-gradient(135deg, #f8b700, #d49b00);
                color: #000; border: none; 
                padding: 10px 20px; border-radius: 30px; 
                cursor: pointer; font-weight: bold; font-size: 14px;
                box-shadow: 0 4px 10px rgba(248, 183, 0, 0.3);
                transition: transform 0.2s;
            }
            .btn-history-login:hover { transform: scale(1.05); }

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
                padding: 8px 20px; border-radius: 20px; cursor: pointer; font-weight: bold; font-size: 14px;
                transition: 0.2s;
            }
            .btn-char-menu:hover { background: #333; color: #fff; border-color: #666; }

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

            .char-tile {
                display: flex; align-items: center; background: #1a1b1d;
                border: 2px solid #0070dd; 
                border-radius: 30px;
                padding: 6px 6px 6px 6px; gap: 10px;
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
            .char-realm { font-size: 10px; color: #888; text-transform: uppercase; letter-spacing: 0.5px; }

            .char-avatar { 
                width: 40px; height: 40px; border-radius: 50%; 
                border: 2px solid #ffd700; background-color: #222; 
                background-size: cover; background-position: center; flex-shrink: 0;
            }
            .char-info { display: flex; flex-direction: column; line-height: 1.2; overflow: hidden; flex-grow: 1; padding-right: 0px; }
            
            .char-profs {
                display: flex; align-items: center; gap: 4px; 
                margin-left: auto; margin-right: 0; padding-right: 0;
                z-index: 5;
            }
            
            .prof-mini-icon {
                width: 40px; height: 40px; border-radius: 50%;
                border: 2px solid #ffd700; background-color: #111;
                object-fit: cover; box-shadow: 0 4px 6px rgba(0,0,0,0.5);
            }
            .prof-mini-icon:hover { transform: none; z-index: auto; cursor: default; }

            .tile-btn {
                position: absolute; width: 22px; height: 22px; border-radius: 50%;
                display: flex; align-items: center; justify-content: center;
                color: white; border: none; cursor: pointer;
                transition: all 0.2s ease; z-index: 10; flex-shrink: 0; padding: 0;
                opacity: 0; transform: scale(0.8);
            }
            .tile-btn:hover { transform: scale(1.15) !important; }
            .tile-btn-edit { top: -6px; left: -6px; background: #007bff; font-size: 12px; } 
            .tile-btn-delete { top: -6px; right: -6px; background: #dc3545; font-size: 14px; line-height: 1; } 
            .char-tile:hover .tile-btn { opacity: 1; transform: scale(1); }

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
            .import-modal-header { display: flex; justify-content: space-between; align-items: center; padding: 15px 20px; background: #1a1b1d; border-bottom: 1px solid #333; width: 100%; box-sizing: border-box; }
            .import-modal-title { font-size: 1.2em; color: #fff; font-weight: bold; letter-spacing: 1px; margin: 0; }
            
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
            .info-badge.crafter-badge { background: linear-gradient(145deg, #2b2515, #1a1a1a); border: 1px solid #7c6a28; color: #ffd700; text-shadow: 0 1px 2px rgba(0,0,0,0.8); box-shadow: 0 2px 5px rgba(0,0,0,0.4); font-weight: bold; }

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
            
            .load-more-container { display: flex; justify-content: center; margin-top: 30px; width: 100%; }
            .btn-load-more { background: #333; border: 1px solid #555; color: #ccc; padding: 10px 30px; border-radius: 4px; cursor: pointer; font-size: 14px; transition: 0.2s; }
            .btn-load-more:hover { background: #444; color: #fff; }
            .hidden { display: none !important; }

            #cartModal .modal-content { max-width: 1400px; width: 95%; }
            #cartBody .check-input { display: none !important; }
            #cartBody .qty-input { margin-right: 0; }
            
            /* HISTORY STYLES */
            .history-login-box { text-align: center; padding: 40px 20px; }
            .history-input { background: #2d2d2d; border: 1px solid #444; color: white; padding: 15px; width: 300px; border-radius: 6px; font-size: 16px; outline: none; text-align: center; margin-bottom: 20px; }
            .history-input:focus { border-color: #f8b700; }
            .history-btn { background: #f8b700; color: #000; border: none; padding: 12px 30px; border-radius: 6px; font-weight: bold; cursor: pointer; }
            .history-btn:hover { background: #e0a800; }
            
            .history-table { width: 100%; border-collapse: collapse; margin-top: 20px; background: #1a1a1a; }
            .history-table th { background: #333; color: #f8b700; padding: 12px; text-align: left; }
            .history-table td { padding: 12px; border-bottom: 1px solid #333; color: #ddd; }
            .h-price { color: #00ff9d; font-family: monospace; font-weight: bold; }
            .h-total { color: #ffd700; font-family: monospace; font-weight: bold; }
            .loader { border: 4px solid #333; border-top: 4px solid #f8b700; border-radius: 50%; width: 30px; height: 30px; animation: spin 1s linear infinite; margin: 20px auto; }
            @keyframes spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }

            /* --- WOW SPELLBOOK DESIGN V3 (Final) --- */

            /* 1. Основний контейнер (Пергамент) */
            #historyModal .modal-content {
                background-color: #110b07; 
                border: none; 
                box-shadow: 0 0 0 2px #000, 0 0 0 5px #a3824b, 0 0 30px rgba(0,0,0,0.9);
                border-radius: 6px;
                color: #f0d0a0;
                font-family: 'Georgia', serif;
                max-width: 1100px; 
                height: 85vh;
                display: flex; flex-direction: column; overflow: hidden;
            }

            /* 2. Шапка (Світліша коричнева) */
            #historyModal .modal-header {
                /* 👇 ФОН ШАПКИ 👇 */
                background-image: none !important;
                background-color: #1a1b1d !important;
                border-bottom: 1px solid #333 !important; /* Тонша рамка під колір */
                
                border-bottom: 2px solid #a3824b; /* Золотий розділювач */
                padding: 20px 30px;
                display: flex;
                justify-content: space-between;
                align-items: flex-start;
                flex-shrink: 0;
                position: relative; /* Щоб фон був під текстом */
                z-index: 1;
            }

            #historyModal .modal-header::before {
                display: none !important;
            }

            /* Заголовок зліва */
            #historyTitle {
                font-size: 24px;
                color: #ffd700;
                font-family: 'Times New Roman', serif;
                letter-spacing: 1px;
                margin: 0;
                text-shadow: 0 2px 4px rgba(0,0,0,0.8);
                align-self: center;
            }

            /* Права частина шапки (Контейнер для кнопок і пошуку) */
            .spellbook-header-right {
                display: flex;
                flex-direction: column;
                align-items: flex-end;
                gap: 10px;
            }

            /* Верхній ряд справа (Бейдж, Вкладки, Хрестик) */
            .header-controls-row {
                display: flex;
                align-items: center;
                gap: 15px;
            }

            /* Вкладки (Tabs) */
            .spellbook-tabs {
                display: flex;
                gap: 5px;
            }

            .spellbook-tab {
                background: #2e2115;
                border: 1px solid #57412d;
                color: #a89070;
                padding: 5px 15px;
                border-radius: 4px;
                cursor: pointer;
                font-size: 12px;
                font-weight: bold;
                font-family: sans-serif;
                transition: 0.2s;
            }

            .spellbook-tab:hover {
                color: #ffd700;
                border-color: #ffd700;
            }

            .spellbook-tab.active {
                background: #8b6946; /* Активна вкладка світліша */
                color: #fff;
                border-color: #ffd700;
                box-shadow: inset 0 0 10px rgba(0,0,0,0.5);
            }

            /* Поле пошуку (Коротке з ефектом) */
            .spellbook-search {
                width: 250px; /* Фіксована ширина */
                height: 20px;
                background: rgba(0, 0, 0, 0.4);
                border: 1px solid #5c452d;
                border-radius: 4px;
                padding: 6px 12px;
                color: #ffd700;
                font-family: sans-serif;
                outline: none;
                transition: all 0.3s ease;
            }

            .spellbook-search:hover, .spellbook-search:focus {
                border-color: #ffd700;
                box-shadow: 0 0 8px rgba(255, 215, 0, 0.4); /* Glow effect */
                background: rgba(0, 0, 0, 0.6);
            }

            /* 3. Тіло (Body) */
            #historyModal .modal-body {
                /* 👇 ФОН ТІЛА 👇 */
                background-image: none !important;
                background-color: #151618 !important;
                
                padding: 20px 30px;
                background-color: #150f0a; 
                overflow-y: auto; 
                flex-grow: 1;
            }

            /* 4. Картка Лота (The Item Card) */
            .spell-grid {
                display: grid;
                grid-template-columns: repeat(3, 1fr); /* 3 колонки */
                grid-auto-rows: max-content;
                gap: 12px;
                margin-top: 10px;
                height: 100%; /* На всю висоту */
                align-content: start; /* Елементи зверху */
            }

            .spell-card {
                display: flex; align-items: center; padding: 8px;
                /* Світлий бежевий фон, як на скріншоті */
                /* Темна рамка */
                border: 1px solid #5c452d; 
                border-radius: 4px; transition: 0.1s; cursor: pointer;
                height: 45px;
                box-shadow: inset 0 0 5px rgba(0,0,0,0.1);
            }
            .spell-card:hover { 
                background: #e8dec8; /* Ще світліше при наведенні */
                border-color: #ffd700; /* Золота рамка при наведенні */
                box-shadow: 0 0 8px rgba(255, 215, 0, 0.4); 
            }

            /* Іконка (Зліва) */
            .spell-icon-frame {
                width: 38px; height: 38px;
                border: 2px solid #bfa785; /* Золотиста рамка іконки */
                border-radius: 4px;
                margin-right: 12px; flex-shrink: 0;
                box-shadow: 0 2px 4px rgba(0,0,0,0.4);
            }
            .spell-icon { width: 100%; height: 100%; object-fit: cover; border-radius: 4px; }

            /* Центральна частина (Назва і кількість) */
            .card-center {
                display: flex;
                flex-direction: column;
                justify-content: center;
                line-height: 1.2;
            }
            .spell-name { 
                font-weight: bold; font-size: 14px; 
                color: #2b1200; /* Темно-коричневий/Чорний текст */
                white-space: nowrap; overflow: hidden; text-overflow: ellipsis; 
            }
            .spell-count-lbl {
                font-size: 11px;
                font-weight: bold;
                color: #555;
                background: rgba(0,0,0,0.05);
                padding: 0 4px;
                border-radius: 4px;
                width: fit-content;
                margin-top: 2px;
            }

            .spell-count-lbl { font-size: 12px; color: #555; font-weight: bold; margin-top: 2px;} /* Темно-сірий */

            /* Права частина (Ціна і Час) */
            .card-right {
                margin-left: auto; /* Притискає вправо */
                display: flex;
                flex-direction: column;
                align-items: flex-end;
                justify-content: center;
                line-height: 1.2;
            }
            .spell-price {
                font-weight: bold;
                font-size: 14px;
                color: #2b5900; /* Зелений як гроші */
            }
            .spell-time {
                font-size: 11px;
                color: #777;
                margin-top: 2px;
            }

            /* 5. Футер (Такий же колір як шапка) */
            .spellbook-footer {
                /* 👇 ФОН ФУТЕРА 👇 */
                background-image: none !important;
                background-color: #1a1b1d !important;
                border-top: 1px solid #333 !important;
                
                border-top: 2px solid #a3824b;
                padding: 15px 30px; 
                display: flex; justify-content: flex-end; align-items: center;
                flex-shrink: 0;
            }

            /* Пагінація */
            .pagination-controls {
                display: flex;
                align-items: center;
                gap: 15px;
            }
            .page-btn {
                background: linear-gradient(to bottom, #d4a017, #b8860b);
                border: 1px solid #8b6914;
                color: #2e2115;
                width: 30px; 
                height: 30px;
                display: flex; align-items: center; justify-content: center;
                border-radius: 4px;
                font-weight: bold;
                cursor: pointer;
                box-shadow: 0 2px 4px rgba(0,0,0,0.5);
            }
            .page-btn:hover { filter: brightness(1.2); }
            .page-label {
                color: #ffd700;
                font-family: serif;
                font-weight: bold;
                letter-spacing: 1px;
            }

            /* Стилі для бейджа гравця (повтор, якщо загубилось) */
            .user-tab-badge { background: #8b6946; border: 1px solid #57412d; border-radius: 4px; padding: 2px 10px; display: flex; align-items: center; gap: 8px; color: #fff; font-family: sans-serif; font-size: 12px; }
            .logout-x {
                cursor: pointer; font-size: 18px; color: #ff9999; margin-left: 8px;
                padding-left: 8px; border-left: 1px solid #555; line-height: 1;
                transition: 0.2s;
            }
            .logout-x:hover { color: #ff0000; text-shadow: 0 0 5px red; }

            /* Новий контейнер для верхньої частини хедера */
                .header-top-row {
                    display: flex;
                    justify-content: space-between;
                    align-items: flex-start;
                    width: 100%;
                }

                /* Ліва частина: Іконка + Заголовок + Пошук */
                .header-left-group {
                    display: flex;
                    flex-direction: column;
                    gap: 10px;
                }

                .title-row {
                    display: flex;
                    align-items: center;
                    gap: 10px;
                }

                .gold-bag-icon {
                    width: 32px;
                    height: 32px;
                    border-radius: 4px;
                    border: 1px solid #ffd700;
                }

                /* Поле пошуку під заголовком */
                .spellbook-search {
                    width: 250px;
                    background: rgba(0, 0, 0, 0.4);
                    border: 1px solid #5c452d;
                    border-radius: 4px;
                    padding: 6px 12px;
                    color: #ffd700;
                    font-family: sans-serif;
                    outline: none;
                    transition: all 0.3s ease;
                }

                /* Права частина: Нік + Хрестик */
                .header-right-group {
                    display: flex;
                    align-items: center;
                    gap: 15px;
                }

                /* Нижній ряд кнопок (Великі) */
                .header-bottom-row {
                    margin-top: 20px;
                    width: 100%;
                    display: flex;
                    gap: 10px;
                }

                .spellbook-tab {
                    flex: 1; /* Кнопки розтягуються на всю ширину */
                    text-align: center;
                    background: #2e2115;
                    border: 1px solid #57412d;
                    color: #a89070;
                    padding: 10px 0; /* Більші кнопки */
                    border-radius: 4px;
                    cursor: pointer;
                    font-size: 14px;
                    font-weight: bold;
                    font-family: sans-serif;
                    transition: 0.2s;
                    text-transform: uppercase;
                }
                .history-coin {
                    width: 14px;
                    height: 14px;
                    vertical-align: middle;
                    border-radius: 50%; /* Робимо круглою */
                    box-shadow: 0 1px 3px rgba(0,0,0,0.5);
                }

                /* --- НОВИЙ ДИЗАЙН SPELLBOOK --- */
                #historyModal .modal-content {
                    background-color: #110b07; /* Темний фон */
                    background-image: url('spellbook_bg.jpg'); background-size: cover; background-position: center;
                    box-shadow: 0 0 0 2px #000, 0 0 0 5px #a3824b, 0 0 30px rgba(0,0,0,0.9); /* Золота рамка */
                    border-radius: 6px; color: #f0d0a0; font-family: 'Georgia', serif;
                    max-width: 1100px; height: 85vh; display: flex; flex-direction: column; overflow: hidden;
                }

                /* Шапка */
                #historyModal .modal-header {
                    background-image: url('header_bg.jpg'); background-size: cover; background-position: bottom;
                    background-color: #221810; border-bottom: 2px solid #a3824b;
                    padding: 20px 30px; display: flex; justify-content: space-between; align-items: flex-start; flex-shrink: 0;
                }

                /* Ліва частина шапки */
                .header-left-col { display: flex; flex-direction: column; gap: 10px; }
                .title-row { display: flex; align-items: center; gap: 10px; }
                .gold-sack-icon { width: 32px; height: 32px; background-image: url('https://wow.zamimg.com/images/wow/icons/large/inv_misc_bag_11.jpg'); background-size: cover; border-radius: 50%; border: 1px solid #ffd700; box-shadow: 0 0 10px rgba(255, 215, 0, 0.6); }
                #historyTitle { font-size: 26px; color: #ffd700; font-family: 'Times New Roman', serif; margin: 0; text-shadow: 0 2px 4px rgba(0,0,0,0.8); }

                /* Пошук */
                .spellbook-search { width: 250px; background: #000; border: 1px solid #5c452d; border-radius: 4px; padding: 6px 10px; color: #ffd700; outline: none; box-shadow: inset 0 2px 5px rgba(0,0,0,0.5); }

                /* Права частина шапки */
                .header-right-col {
                    display: flex !important;
                    flex-direction: column !important; /* Елементи один під одним */
                    align-items: flex-end !important; /* Притиснути вправо */
                    gap: 8px !important;
                }
                .top-controls { display: flex; align-items: center; gap: 15px; }
                #userNameDisplay { font-size: 20px; color: #f0d0a0; font-weight: bold; text-shadow: 0 2px 4px #000; }

                /* Вкладки */
                .spellbook-tabs { display: flex; gap: 5px; }
                .spellbook-tab { background: linear-gradient(to bottom, #4a3826, #2e2115); border: 1px solid #755e42; color: #a89070; padding: 6px 20px; border-radius: 4px; cursor: pointer; font-size: 13px; font-weight: bold; transition: 0.2s; min-width: 100px; text-align: center; }
                .spellbook-tab.active { background: #7a5c3b; color: #fff; border-color: #ffd700; box-shadow: inset 0 0 10px rgba(0,0,0,0.5); }

                /* Тіло і Сітка */
                #historyModal .modal-body { padding: 20px 30px; background-color: #150f0a; background-image: url('body_bg.jpg'); background-size: cover; overflow-y: auto; flex-grow: 1; }

                .card-right { margin-left: auto; text-align: right; }
                .spell-price { font-weight: bold; font-size: 13px; color: #1eff00; display: flex; align-items: center; justify-content: flex-end; gap: 4px; }
                .coin-icon { width: 12px; height: 12px; border: none; border-radius: 50%; vertical-align: middle; }
                .spell-time { font-size: 11px; color: #777; margin-top: 2px; }

                /* Футер */
                .spellbook-footer { background-image: url('header_bg.jpg'); background-size: cover; background-position: bottom; background-color: #221810; border-top: 2px solid #a3824b; padding: 10px 30px; display: flex; justify-content: flex-end; align-items: center; flex-shrink: 0; }
                .page-btn { background: linear-gradient(to bottom, #d4a017, #b8860b); border: 1px solid #8b6914; color: #2e2115; width: 25px; height: 25px; display: flex; align-items: center; justify-content: center; border-radius: 4px; cursor: pointer; font-weight: bold; }
                .pagination-controls { display: flex; align-items: center; gap: 10px; }
                .page-label { color: #ffd700; font-weight: bold; font-size: 12px; }

                /* Деталі (Графік) */
                #itemDetailsModal .modal-content { max-width: 900px; height: 600px; background: #111; border: 2px solid #5c452d; display: flex; flex-direction: column; }
                .details-body { display: flex; height: 100%; overflow: hidden; }
                .details-chart-col { width: 70%; padding: 20px; background: #0f1011; border-right: 1px solid #333; }
                .details-list-col { width: 30%; background: #1a1a1a; overflow-y: auto; padding: 10px; }
                .sale-row { display: flex; justify-content: space-between; padding: 8px; border-bottom: 1px solid #333; font-size: 12px; color: #ccc; }
                
                /* Заголовок Експаншена */
                .expansion-header {
                grid-column: 1 / -1; 
                text-align: center; font-family: serif; font-size: 16px;
                color: #5c452d; font-weight: bold; text-transform: uppercase;
                margin: 10px 0 5px 0; border-bottom: 1px solid rgba(92, 69, 45, 0.3);
                }

            /* --- FORCE OVERRIDE: LIGHT THEME v3 (Transparent + No Border) --- */
            
            /* 1. Фон картки (Напівпрозорий + Без рамки) */
            #historyModal .spell-card {
                background-color: rgba(111, 108, 105, 0.2) !important; 
                background-image: none !important;
                
                border: none !important; /* Прибрали бордер */
                border-radius: 4px !important;
                
                box-shadow: inset 0 0 5px rgba(0,0,0,0.05) !important;
                padding: 6px 10px !important;
                height: 42px !important;
                display: flex !important;
                align-items: center !important;
            }

            /* Ефект при наведенні (стає менш прозорим для контрасту) */
            #historyModal .spell-card:hover {
                background-color: rgba(163, 153, 139, 0.2) !important; 
                box-shadow: 0 2px 8px rgba(0,0,0,0.2) !important;
            }

            /* 2. Текст назви (Темно-коричневий) */
            #historyModal .spell-name {
                color: #e0e0e0 !important; 
                font-family: sans-serif !important;
                font-weight: bold !important;
                font-size: 14px !important;
                text-shadow: none !important;
            }

            /* 3. Кількість (Сірий) */
            #historyModal .spell-count-lbl {
                color: #797979 !important;
                font-weight: bold !important;
                font-size: 12px !important;
                background: transparent !important;
                margin-top: 2px !important;
            }

            /* 4. Ціна (Зелена) */
            #historyModal .spell-price {
                color: #2ec100 !important; 
                font-weight: bold !important;
                font-size: 14px !important;
                text-shadow: none !important;
            }

            /* 5. Іконка золота (Чиста) */
            #historyModal .coin-icon {
                border: none !important;
                box-shadow: none !important;
                width: 13px !important;
                height: 13px !important;
                vertical-align: middle !important;
                border-radius: 0 !important;
            }

            /* 6. Рамка іконки предмета */
            #historyModal .spell-icon-frame {
                border: 1px solid #755e42 !important;
                border-radius: 4px !important;
                box-shadow: none !important;
                width: 36px !important;
                height: 36px !important;
                margin-right: 10px !important;
            }

            /* --- КНОПКА ВИДАЛЕННЯ З КОРЗИНИ --- */
            .btn-remove-cart {
                position: absolute;
                top: 5px;
                right: 5px;
                width: 24px;
                height: 24px;
                background: #ff4d4d; /* Червоний колір */
                color: white;
                border-radius: 50%; /* Кругла форма */
                display: flex;
                align-items: center;
                justify-content: center;
                font-weight: bold;
                font-size: 16px;
                cursor: pointer;
                box-shadow: 0 2px 5px rgba(0,0,0,0.5);
                border: 2px solid #1a1b1d; /* Обводка під колір фону, щоб виглядало як "виріз" */
                z-index: 100;
                
                /* Анімація появи */
                opacity: 0; 
                transform: scale(0.8);
                transition: all 0.2s cubic-bezier(0.175, 0.885, 0.32, 1.275);
                line-height: 1; /* Центрування хрестика */
            }

            .btn-remove-cart:hover {
                background: #ff0000;
                transform: scale(1.1);
            }

            /* Показуємо кнопку при наведенні на картку */
            .item-card:hover .btn-remove-cart {
                opacity: 1;
                transform: scale(1);
            }

            .item-card {
                position: relative !important;
            }


        </style>
    </head>
    <body>
        <div id="topLeftSection">
             <button id="btnHistoryLogin" class="btn-history-login">Tracker Login</button>
        </div>

        <div id="topRightSection">
            <div id="btnAddCharWrapper" class="add-char-btn" onclick="openImportModal()">
                <div class="add-char-circle">+</div>
                <div class="add-char-label">Add your first character</div>
            </div>

            <div id="charMenuContainer" class="char-menu-container" style="display:none;">
                <button id="btnCharMenu" class="btn-char-menu">Characters</button>
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
        
        <div id="historyModal" class="modal-overlay">
            <div class="modal-content">
                <div class="modal-header">
                    <div class="header-left-col">
                        <div class="title-row">
                            <div class="gold-sack-icon"></div>
                            <h2 id="historyTitle">Sales History</h2>
                        </div>
                        <input type="text" id="historySearch" class="spellbook-search" placeholder="Search item..." onkeyup="filterHistory()">
                    </div>

                    <div class="header-right-col">
                        <button id="btnCloseHistory" class="modal-close" style="font-size:24px; color:#a89070; border-color:#5c452d;">×</button>
                        
                        <div style="display:flex; align-items:center;">
                            <span id="userNameDisplay" style="font-size: 16px; color: #a89070; font-weight:bold; margin-right: 5px;">Player</span>
                            <span class="logout-x" onclick="logoutHistory()" title="Logout" style="font-size:16px; color:#ff5555; cursor:pointer;">×</span>
                        </div>
                    </div>
                </div>

                <div class="modal-body">
                    <div id="historyLoginState" class="spellbook-login">
                        <p style="color:#a89070;">Identify yourself...</p>
                        <input type="text" id="historyBinInput" class="spellbook-input" placeholder="Enter Bin ID">
                        <br><button onclick="loginHistory()" class="spellbook-btn">Open Book</button>
                    </div>

                    <div id="historyDataState" style="display:none;">
                        <div id="historyLoader" style="text-align:center; padding:40px; color:#a89070;">Loading...</div>
                        <div id="historyGrid" class="spell-grid"></div> <div id="historyEmpty" style="text-align:center; padding:50px; color:#666; display:none;">No records found.</div>
                    </div>
                </div>
            </div>
        </div>

        <div id="itemDetailsModal" class="modal-overlay">
            <div class="modal-content">
                <div class="modal-header" style="justify-content: space-between; align-items: center; background:#221810;">
                    <h3 id="detailItemName" style="color: #ffd700; margin: 0;">Item Name</h3>
                    <button onclick="closeItemDetails()" class="modal-close" style="color:#a89070;">×</button>
                </div>
                <div class="details-body">
                    <div class="details-chart-col"><canvas id="itemDetailChart"></canvas></div>
                    <div class="details-list-col" id="detailListContainer"></div>
                </div>
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
            const FULL_DB = ${jsonFullDb}; // Ось тут ми отримуємо базу іконок з Кроку 1
            let currentHistoryData = [];
            // Змінні для пагінації історії
            let historyGroupedData = []; // Тут зберігаємо вже згруповані лоти
            let historyCurrentPage = 1;
            const HISTORY_ITEMS_PER_PAGE = 15; // Скільки лотів на сторінку (налаштуй під висоту вікна)
            let detailChartInstance = null;
            const ALL_DATA = ${jsonPayload};
            const SKILL_REQS = ${jsonSkillReq};
            
            // ВШИВАЄМО КЛЮЧ ПРЯМО ТУТ (hardcoded)
            const MASTER_KEY = '$2a$10$XsAeGChQRacvy3Zymhgl4e2T0lq3eRgHTin6EuwGztMpDjOPyFa3q'; 
            
            let activeData = ALL_DATA; 
            let currentIndex = 0;
            const ITEMS_PER_PAGE = 20;
            let activeCharts = {};
            let chartRanges = {}; 
            
            let savedState = JSON.parse(localStorage.getItem('wowScnr_state')) || {};
            let charsList = JSON.parse(localStorage.getItem('wowScnr_chars_list')) || [];
            let parsedChars = [];

            const EXPANSION_MAP = {
                "Burning Crusade": "Outland", "Wrath of the Lich King": "Northrend", "Cataclysm": "Cataclysm", "Mists of Pandaria": "Pandaria", "Warlords of Draenor": "Draenor", "Legion": "Legion", "Battle for Azeroth": "Zandalari", "Shadowlands": "Shadowlands", "Dragonflight": "Dragon Isles", "The War Within": "Khaz Algar", "Vanilla": "Classic" 
            };

            function saveToStorage() { localStorage.setItem('wowScnr_state', JSON.stringify(savedState)); }
            function saveCharsToStorage() { 
                localStorage.setItem('wowScnr_chars_list', JSON.stringify(charsList)); 
                reparseAllCharacters();
                updateTopRightSection();
                updateVisibleCrafterBadges();
            }

            function reparseAllCharacters() {
                parsedChars = charsList.map(char => {
                    return { name: char.name, p1: extractSkillData(char.p1), p2: extractSkillData(char.p2) };
                });
            }

            function extractSkillData(str) {
                if (!str) return null;
                let root; try { root = JSON.parse(str); } catch(e) { return null; }
                let title = "Unknown Profession"; let skillsFound = [];
                function traverse(node) {
                    if (typeof node !== 'object' || node === null) return;
                    if (node.name && (node.skill !== undefined || node.value !== undefined)) {
                        const n = node.name.toLowerCase();
                        if(title === "Unknown Profession") {
                            if(n.includes("inscription")) title = "Inscription"; else if(n.includes("alchemy")) title = "Alchemy"; else if(n.includes("jewelcrafting")) title = "Jewelcrafting"; else if(n.includes("blacksmithing")) title = "Blacksmithing"; else if(n.includes("enchanting")) title = "Enchanting"; else if(n.includes("engineering")) title = "Engineering"; else if(n.includes("leatherworking")) title = "Leatherworking"; else if(n.includes("tailoring")) title = "Tailoring";
                        }
                        let current = node.skill !== undefined ? node.skill : node.value;
                        let max = node.maxSkill !== undefined ? node.maxSkill : (node.max !== undefined ? node.max : 100);
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
                                if (skillEntry.skill >= requiredSkill) validCrafters.push(char.name);
                            }
                        }
                    });
                });
                return validCrafters.length > 0 ? validCrafters.join(', ') : null;
            }

            function updateVisibleCrafterBadges() {
                const cards = document.querySelectorAll('.item-card');
                cards.forEach(card => {
                    const itemId = card.dataset.id;
                    const itemData = ALL_DATA.find(i => i.itemId == itemId);
                    if (itemData) {
                        const crafterName = findCrafters(itemData.exp, itemData.prof);
                        const leftCol = card.querySelector('.main-row-left');
                        const existingBadge = leftCol.querySelector('.crafter-badge');
                        if (existingBadge) existingBadge.remove();
                        if (crafterName) {
                            const badge = document.createElement('div');
                            badge.className = 'info-badge crafter-badge';
                            badge.textContent = crafterName;
                            const expBadge = leftCol.querySelector('.info-badge:not(.crafter-badge)');
                            if (expBadge) leftCol.insertBefore(badge, expBadge); else leftCol.appendChild(badge);
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
                
                let name = "Unknown"; let realm = "Unknown"; let charClass = "unknown"; 
                function parseMeta(str) {
                    try { const obj = JSON.parse(str); if(obj.character) name = obj.character; if(obj.realm) realm = obj.realm; if(obj.class) charClass = obj.class.toLowerCase().replace(/\\s/g, ''); } catch(e) {}
                }
                parseMeta(p1Str); parseMeta(p2Str);
                if ((p1Str || p2Str) && name === "Unknown") name = "Imported Char";
                const newChar = { name, realm, class: charClass, p1: p1Str, p2: p2Str };

                if (editId >= 0) charsList[editId] = newChar; else charsList.push(newChar);
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
                    if (!data || data.skills.length === 0) return \`<div class="prof-col"><div class="prof-title-wrapper"><span class="prof-title">\${defaultTitle}</span></div><div style="color:#666">No skill data found</div></div>\`;
                    const iconName = data.title.toLowerCase().replace(/\\s+/g, '');
                    const iconUrl = \`prof_class_icons/\${iconName}.jpg\`;
                    let rows = '';
                    data.skills.forEach(s => {
                        const pct = Math.min(100, (s.skill / s.max) * 100);
                        rows += \`<div class="prof-row"><div class="prof-header"><span>\${s.name}</span><span>\${s.skill} / \${s.max}</span></div><div class="skill-bar-bg"><div class="skill-bar-fill" style="width:\${pct}%"></div></div></div>\`;
                    });
                    return \`<div class="prof-col"><div class="prof-title-wrapper"><img src="\${iconUrl}" class="prof-icon" onerror="this.style.display='none'"><span class="prof-title">\${data.title}</span></div>\${rows}</div>\`;
                }
                const data1 = extractSkillData(char.p1);
                const data2 = extractSkillData(char.p2);
                const leftHtml = buildHtmlColumn(data1, "Profession 1");
                const rightHtml = buildHtmlColumn(data2, "Profession 2");
                body.innerHTML = \`<div class="details-grid">\${leftHtml}\${rightHtml}</div>\`;
                document.getElementById('charDetailsModal').classList.add('active');
            }
            
            document.getElementById('btnCloseDetails').addEventListener('click', () => { document.getElementById('charDetailsModal').classList.remove('active'); });

            function renderCharList() {
                const container = document.getElementById('charList');
                container.innerHTML = '';
                const getProfFilename = (fullTitle) => {
                    if (!fullTitle) return "Unknown";
                    const t = fullTitle.toLowerCase();
                    if (t.includes("alchemy")) return "Alchemy"; if (t.includes("blacksmithing")) return "Blacksmithing"; if (t.includes("enchanting")) return "Enchanting"; if (t.includes("engineering")) return "Engineering"; if (t.includes("herbalism")) return "Herbalism"; if (t.includes("inscription")) return "Inscription"; if (t.includes("jewelcrafting")) return "Jewelcrafting"; if (t.includes("leatherworking")) return "Leatherworking"; if (t.includes("mining")) return "Mining"; if (t.includes("skinning")) return "Skinning"; if (t.includes("tailoring")) return "Tailoring"; if (t.includes("cooking")) return "Cooking"; if (t.includes("fishing")) return "Fishing";
                    return "Unknown"; 
                };
                charsList.forEach((char, index) => {
                    const iconName = char.class ? char.class.toLowerCase().replace(/\s+/g, '') : "unknown";
                    const iconUrl = \`prof_class_icons/\${iconName}.jpg\`;
                    const p1Data = extractSkillData(char.p1);
                    const p2Data = extractSkillData(char.p2);
                    let profsHtml = '<div class="char-profs">';
                    [p1Data, p2Data].forEach(p => {
                        if (p && p.title && p.title !== "Unknown Profession") {
                            const simpleName = getProfFilename(p.title);
                            profsHtml += '<img src="prof_class_icons/' + simpleName + '.jpg" class="prof-mini-icon" title="' + p.title + '" onerror="this.hidden=true">';
                        }
                    });
                    profsHtml += '</div>';
                    const div = document.createElement('div');
                    div.className = 'char-tile';
                    div.innerHTML = \`<button class="tile-btn tile-btn-edit" onclick="openCharDetails(\${index})">✎</button><button class="tile-btn tile-btn-delete" onclick="deleteCharacter(\${index})">×</button><div class="char-avatar" style="background-image: url('\${iconUrl}');"></div><div class="char-info"><div class="char-name">\${char.name}</div><div class="char-realm">\${char.realm}</div></div>\${profsHtml}\`;
                    container.appendChild(div);
                });
            }

            function setChartRange(btn, itemId, range) {
                const parent = btn.parentElement; parent.querySelectorAll('.chart-btn').forEach(b => b.classList.remove('active')); btn.classList.add('active');
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
                gradient.addColorStop(0, 'rgba(0, 112, 221, 0.6)'); gradient.addColorStop(1, 'rgba(0, 112, 221, 0.0)');
                const range = chartRanges[itemId] || '1m';
                const now = Date.now();
                let cutoff = 0;
                switch(range) { case '1w': cutoff = now - (604800000); break; case '1m': cutoff = now - (2592000000); break; case '6m': cutoff = now - (15552000000); break; case '1y': cutoff = now - (31536000000); break; default: cutoff = 0; }
                const filteredHistory = itemData.history.filter(h => h.t >= cutoff);
                const labels = filteredHistory.map(h => { const d = new Date(h.t); return d.toLocaleDateString() + ' ' + d.getHours() + ':00'; });
                const dataPoints = filteredHistory.map(h => h.p);
                activeCharts[itemId] = new Chart(ctx, {
                    type: 'line',
                    data: { labels: labels, datasets: [{ label: 'Price', data: dataPoints, borderColor: '#0070dd', backgroundColor: gradient, borderWidth: 2, tension: 0.4, fill: true, pointRadius: dataPoints.length < 2 ? 5 : 0, pointHoverRadius: 6, pointBackgroundColor: '#fff' }] },
                    options: { animation: false, responsive: true, maintainAspectRatio: false, interaction: { mode: 'index', intersect: false }, plugins: { legend: { display: false }, tooltip: { backgroundColor: 'rgba(0,0,0,0.8)', titleColor: '#fff', bodyColor: '#0070dd', displayColors: false, callbacks: { label: (c) => c.parsed.y.toLocaleString() + ' g' } } }, scales: { x: { display: false }, y: { display: false } } }
                });
            }

            function copyName(el) { const text = el.firstChild.textContent; navigator.clipboard.writeText(text).then(() => { el.classList.add('copied'); setTimeout(() => el.classList.remove('copied'), 1500); }); }

            function handleReset() {
                if(!confirm("Очистити вибір предметів? (Персонажі залишаться)")) return;
                localStorage.removeItem('wowScnr_state');
                savedState = {};
                document.querySelectorAll('.check-input').forEach(el => el.checked = false);
                document.querySelectorAll('.qty-input').forEach(el => el.value = '');
                document.getElementById('smartSearchInput').value = '';
                activeData = ALL_DATA; currentIndex = 0; document.getElementById('list').innerHTML = ''; loadMore();
                updateTopRightSection(); updateVisibleCrafterBadges();
            }

            function openCart() {
                const modal = document.getElementById('cartModal');
                const body = document.getElementById('cartBody');
                body.innerHTML = '';
                const checkedIds = Object.keys(savedState).filter(id => savedState[id] && savedState[id].checked);
                if (checkedIds.length === 0) body.innerHTML = '<div class="empty-cart-msg">Кошик порожній.</div>';
                else { const cartItems = ALL_DATA.filter(item => checkedIds.includes(item.itemId.toString())); body.innerHTML = cartItems.map(createCartItemHTML).join(''); }
                modal.classList.add('active');
            }

            // --- ФУНКЦІЯ ВИДАЛЕННЯ З КОРЗИНИ (FIXED & CLEAR INPUT) ---
            window.removeFromCart = function(itemId, btnElement) {
                // 1. Оновлюємо стан (знімаємо галочку і обнуляємо кількість)
                if (savedState[itemId]) {
                    savedState[itemId].checked = false;
                    savedState[itemId].qty = 0; // <-- Важливо: скидаємо кількість в пам'яті
                    saveToStorage();
                }

                // 2. Анімація видалення картки
                const card = btnElement.closest('.item-card');
                card.style.transition = 'all 0.3s ease';
                card.style.opacity = '0';
                card.style.transform = 'scale(0.9)';
                
                setTimeout(() => {
                    card.remove();
                    
                    // Перевіряємо, чи не пуста корзина
                    const body = document.getElementById('cartBody');
                    if (body.children.length === 0) {
                        body.innerHTML = '<div class="empty-cart-msg">Кошик порожній.</div>';
                    }
                }, 300);

                // 3. Синхронізація з головним списком
                const mainListCard = document.querySelector(\`#list .item-card[data-id="\${itemId}"]\`);
                
                if (mainListCard) {
                    // Знімаємо галочку
                    const checkbox = mainListCard.querySelector('.check-input');
                    if (checkbox) {
                        checkbox.checked = false;
                    }
                    
                    // Очищуємо поле кількості
                    const qtyInput = mainListCard.querySelector('.qty-input');
                    if (qtyInput) {
                        qtyInput.value = ''; // <-- Очищуємо візуально
                    }
                }
            }

            function closeCart() { document.getElementById('cartModal').classList.remove('active'); document.getElementById('list').innerHTML = ''; currentIndex = 0; loadMore(); updateVisibleCrafterBadges(); }

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
                        if (exp) {
                            if (!summary[exp]) summary[exp] = { totalLumber: 0, items: [] };
                            summary[exp].totalLumber += totalLumber;
                            const crafter = findCrafters(itemData.exp, itemData.prof) || "";
                            summary[exp].items.push({ name: itemData.name, price: itemData.bestPrice, count: count, crafter: crafter, craftCost: Math.floor(itemData.craftCost), prof: itemData.prof });
                        }
                    }
                });
                const payload = Object.keys(summary).map(exp => ({ "Exp": exp, "craftQty": summary[exp].totalLumber, "items": summary[exp].items }));
                if (payload.length === 0) return alert("Помилка даних або не введено кількість.");
                visualCopy(btn, JSON.stringify(payload));
            }

            function handleReagentsImport(e) {
                const btn = e.currentTarget;
                if (btn.dataset.locked === "true") return;
                btn.dataset.locked = "true"; setTimeout(() => { delete btn.dataset.locked; }, 500);
                const checkedIds = Object.keys(savedState).filter(id => savedState[id] && savedState[id].checked);
                if (checkedIds.length === 0) return alert("Вибери предмети!");
                let reagentsMap = {}; let hasItems = false;
                checkedIds.forEach(id => {
                    const itemData = ALL_DATA.find(i => i.itemId == id);
                    if (!itemData) return;
                    const count = parseInt(savedState[id].qty) || 0;
                    if (count > 0) {
                        hasItems = true;
                        if (itemData.recipeRaw && Array.isArray(itemData.recipeRaw)) {
                            itemData.recipeRaw.forEach(r => { if (!reagentsMap[r.name]) reagentsMap[r.name] = 0; reagentsMap[r.name] += (r.count * count); });
                        }
                    }
                });
                if (!hasItems) return alert("Введи кількість!");
                let importString = "Decor Shopping List";
                Object.entries(reagentsMap).forEach(([name, qty]) => {
                    const cleanName = name.replace(/"/g, '\\"');
                    importString += \`^"\${cleanName}";;0;0;0;0;0;0;0;0;;#;;\${qty}\`;
                });
                visualCopy(btn, importString);
            }

            function visualCopy(btn, text) {
                if (btn.copyTimer) clearTimeout(btn.copyTimer);
                navigator.clipboard.writeText(text).catch(err => console.error(err));
                btn.innerText = "Скопійовано!";
                btn.style.backgroundColor = "#a335ee"; 
                btn.copyTimer = setTimeout(() => {
                    btn.style.backgroundColor = ""; 
                    if (btn.classList.contains('btn-import')) btn.innerText = "Reagents Import";
                    else if (btn.classList.contains('btn-import-addon')) btn.innerText = "Lumber Import";
                    else if (btn.id === 'btnOpenCart') btn.innerText = "🛒 Cart";
                    else btn.innerText = "Import";
                    btn.copyTimer = null;
                }, 2000);
            }

            function createItemHTML(item) { return generateItemHtmlString(item, true); }
            function createCartItemHTML(item) { return generateItemHtmlString(item, false); }

            function generateItemHtmlString(item, expandale) {
                // 1. Підготовка даних
                const recipeJson = JSON.stringify(item.recipeRaw).replace(/"/g, '&quot;');
                const saved = savedState[item.itemId] || {};
                const isChecked = saved.checked ? 'checked' : '';
                const qtyVal = saved.qty && saved.qty > 0 ? saved.qty : '';
                
                // 2. Крафтер і Бейджі
                const crafterName = findCrafters(item.exp, item.prof);
                const crafterHtml = crafterName ? \`<div class="info-badge crafter-badge">\${crafterName}</div>\` : '';
                
                // 3. Рецепти (Екрануємо \` та \${)
                let recipeHtml = item.reagentsList && item.reagentsList.length > 0 
                    ? '<ul class="recipe-list">' + item.reagentsList.map(r => \`<li><div class="reag-left"><span style="color:#ffd700;font-weight:bold">\${r.count}x</span> <img src="\${r.icon}" class="reag-icon"> <span>\${r.name}</span></div><div class="reag-right">\${r.price < 10 ? parseFloat(r.price.toFixed(2)) : Math.floor(r.price).toLocaleString()} <img src="https://wow.zamimg.com/images/wow/icons/large/inv_misc_coin_01.jpg" class="coin-xs"></div></li>\`).join('') + '</ul>' 
                    : '<div style="color:#555">No recipe</div>';
                
                // 4. Топ 10 серверів
                const top10Html = item.top10.map(l => \`<div class="server-row"><span>\${l.r}</span><span class="server-price">\${l.p.toLocaleString()} <img src="https://wow.zamimg.com/images/wow/icons/large/inv_misc_coin_01.jpg" class="coin-xs"></span></div>\`).join('');
                
                // 5. Ціна лісу (Lumber)
                let lumberClass = item.lumberPrice > 0 ? "positive" : (item.lumberPrice > -999999 ? "negative" : "neutral");
                const dispLumber = item.lumberPrice > -999999 ? Math.floor(item.lumberPrice).toLocaleString() : 'N/A';
                const toggleAttr = expandale ? \`onclick="toggleDetails(this.closest('.item-card'), \${item.itemId})"\` : '';

                // 6. ЛОГІКА КНОПКИ ВИДАЛЕННЯ (Тільки для кошика)
                const removeBtnHtml = !expandale 
                    ? \`<div class="btn-remove-cart" onclick="removeFromCart('\${item.itemId}', this)" title="Видалити з кошика">×</div>\` 
                    : '';

                // 7. ЛОГІКА ДЕТАЛЕЙ (Винесли в окрему змінну для читабельності)
                // УВАГА: Тут теж все екрановано (\` та \${)
                const detailsRowHtml = expandale 
                    ? \`<div class="details-row"><div class="details-content"><div class="details-left"><div class="chart-wrapper"><div class="chart-controls"><button class="chart-btn" onclick="setChartRange(this, '\${item.itemId}', '1w')">1W</button><button class="chart-btn active" onclick="setChartRange(this, '\${item.itemId}', '1m')">1M</button><button class="chart-btn" onclick="setChartRange(this, '\${item.itemId}', '6m')">6M</button><button class="chart-btn" onclick="setChartRange(this, '\${item.itemId}', '1y')">1Y</button></div><canvas id="chart-\${item.itemId}"></canvas></div><div class="reagents-block"><div style="display:flex;justify-content:space-between;margin-bottom:10px"><h4>Recipe Cost</h4><span style="color:#f44336;font-weight:bold">Total: -\${Math.floor(item.craftCost).toLocaleString()} <img src="https://wow.zamimg.com/images/wow/icons/large/inv_misc_coin_01.jpg" class="coin-xs"></span></div>\${recipeHtml}\${item.craftQty > 0 ? \`<div style="margin-top:10px;color:#4caf50;text-align:center;background:#1a3b1a;padding:5px;border-radius:4px">Requires: <b>\${item.craftQty}</b> Lumber</div>\` : ''}</div></div><div class="details-right"><h4>Cheapest Realms (Top 10)</h4>\${top10Html}</div></div></div>\`
                    : '';

                // 8. ФІНАЛЬНИЙ HTML
                return \`<div class="item-card" data-id="\${item.itemId}" data-recipe="\${recipeJson}" data-exp="\${item.exp || ''}" data-lumber="\${item.craftQty || 0}">
                    \${removeBtnHtml}
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
                    \${detailsRowHtml}
                </div>\`;
            }

            function loadMore() {
                const list = document.getElementById('list');
                const btn = document.getElementById('btnLoadMore');
                const nextItems = activeData.slice(currentIndex, currentIndex + ITEMS_PER_PAGE);
                if (nextItems.length > 0) { 
                    const htmlItems = nextItems.map(function(item) { return createItemHTML(item); }).join('');
                    list.insertAdjacentHTML('beforeend', htmlItems); currentIndex += nextItems.length;
                }
                if (currentIndex >= activeData.length) btn.style.display = 'none'; else btn.style.display = 'block';
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

            // --- HISTORY LOGIC ---
            function checkHistorySession() {
                const id = localStorage.getItem('wow_bin_id');
                const btn = document.getElementById('btnHistoryLogin');
                
                if (id) { 
                    btn.textContent = "History"; 
                    btn.onclick = openHistoryModal; 
                } else { 
                    btn.textContent = "Tracker Login"; 
                    btn.onclick = openHistoryModal;
                    // Ховаємо бейдж якщо не залогінені
                    const badge = document.getElementById('userBadge');
                    if(badge) badge.style.display = 'none';
                }
            }

            function openHistoryModal() {
                const id = localStorage.getItem('wow_bin_id');
                if (id) {
                    document.getElementById('historyLoginState').style.display = 'none';
                    document.getElementById('historyDataState').style.display = 'block';
                    loadHistoryData(id);
                } else {
                    document.getElementById('historyLoginState').style.display = 'block';
                    document.getElementById('historyDataState').style.display = 'none';
                }
                document.getElementById('historyModal').classList.add('active');
            }

            async function loginHistory() {
                const id = document.getElementById('historyBinInput').value.trim();
                if (id.length < 5) return alert("ID is too short");
                localStorage.setItem('wow_bin_id', id);
                checkHistorySession();
                openHistoryModal();
            }

            function logoutHistory() {
                localStorage.removeItem('wow_bin_id');
                location.reload();
            }

            function switchTab(tab) {
                // Знімаємо active з усіх
                document.querySelectorAll('.spellbook-tab').forEach(el => el.classList.remove('active'));
                // Шукаємо кнопку, на яку натиснули (по тексту або події)
                // Для простоти, в HTML я додав onclick="switchTab('...')"
                // Тут ми просто візуально підсвічуємо потрібну
                const tabs = document.querySelectorAll('.spellbook-tab');
                if (tab === 'sales') {
                    tabs[0].classList.add('active');
                    document.getElementById('historyGrid').style.opacity = '1';
                } else {
                    tabs[1].classList.add('active');
                    // Поки що заглушка для "All Decors"
                    // document.getElementById('historyGrid').style.opacity = '0.5'; 
                    alert("Режим 'All Decors' буде доступний згодом!");
                    tabs[0].classList.add('active'); // Повертаємо назад
                    tabs[1].classList.remove('active');
                }
            }

            async function loadHistoryData(binId) {
                document.getElementById('historyLoader').style.display = 'block';
                document.getElementById('historyGrid').innerHTML = '';
                document.getElementById('historyEmpty').style.display = 'none';
                
                try {
                    const response = await fetch('https://api.jsonbin.io/v3/b/' + binId + '/latest', {
                        headers: { 'X-Master-Key': MASTER_KEY }
                    });
                    const json = await response.json();
                    let data = json.record;
                    currentHistoryData = data; 
                    
                    if (data[0] && data[0].seller) {
                        const userSpan = document.getElementById('userNameDisplay');
                        if(userSpan) {
                            userSpan.innerText = data[0].seller;
                            userSpan.parentElement.style.display = 'flex';
                        }
                    }

                    if (!Array.isArray(data) || data.length === 0) {
                        document.getElementById('historyLoader').style.display = 'none';
                        document.getElementById('historyEmpty').style.display = 'block';
                        return;
                    }

                    // 1. Групуємо дублікати (як і раніше)
                    const groupedItems = {};
                    
                    data.forEach(row => {
                        if (!row.item) return;
                        const name = row.item;
                        
                        if (!groupedItems[name]) {
                            let itemMeta = ALL_DATA.find(i => i.name === name);
                            if (!itemMeta) itemMeta = ALL_DATA.find(i => i.name.toLowerCase().includes(name.toLowerCase()));
                            
                            groupedItems[name] = {
                                name: name,
                                totalCount: 0,
                                totalRevenue: 0,
                                icon: (itemMeta && itemMeta.icon) ? itemMeta.icon : null,
                                craftCost: (itemMeta && itemMeta.craftCost) ? itemMeta.craftCost : 0
                            };
                        }
                        
                        groupedItems[name].totalCount += (row.count || 1);
                        groupedItems[name].totalRevenue += (row.price / 10000); 
                    });

                    // 2. Робимо простий масив
                    const itemsArray = Object.values(groupedItems);
                    
                    // Сортуємо: Найдорожчі (по виручці) зверху
                    itemsArray.sort((a, b) => b.totalRevenue - a.totalRevenue);

                    const grid = document.getElementById('historyGrid');

                    // 3. Малюємо картки (без заголовків експаншенів)
                    itemsArray.forEach(group => {
                        const iconUrl = group.icon || 'https://wow.zamimg.com/images/wow/icons/large/inv_misc_questionmark.jpg';
                        
                        const totalCost = group.craftCost * group.totalCount;
                        const profit = group.totalRevenue - totalCost;
                        const profitStr = Math.floor(profit).toLocaleString('uk-UA');

                        const card = document.createElement('div');
                        card.className = 'spell-card';
                        card.setAttribute('data-name', group.name.toLowerCase());
                        card.onclick = function() { openItemDetails(group.name); };

                        // Стилі беруться з твого CSS, який ти додав в кінці
                        card.innerHTML = 
                            '<div class="spell-icon-frame"><img src="' + iconUrl + '" class="spell-icon"></div>' +
                            '<div class="card-center">' +
                                '<div class="spell-name">' + group.name + '</div>' +
                                '<div class="spell-count-lbl">x' + group.totalCount + ' sold</div>' +
                            '</div>' +
                            '<div class="card-right">' +
                                '<div class="spell-price" title="Profit">' + 
                                    profitStr + ' <img src="https://wow.zamimg.com/images/wow/icons/large/inv_misc_coin_01.jpg" class="coin-icon">' + 
                                '</div>' +
                            '</div>';
                        
                        grid.appendChild(card);
                    });

                    document.getElementById('historyLoader').style.display = 'none';
                } catch (e) { console.error(e); }
            }

            function renderHistoryPage() {
                const grid = document.getElementById('historyGrid');
                grid.innerHTML = '';

                const totalItems = historyGroupedData.length;
                const totalPages = Math.ceil(totalItems / HISTORY_ITEMS_PER_PAGE) || 1;

                // Перевірка меж
                if (historyCurrentPage < 1) historyCurrentPage = 1;
                if (historyCurrentPage > totalPages) historyCurrentPage = totalPages;

                const startIndex = (historyCurrentPage - 1) * HISTORY_ITEMS_PER_PAGE;
                const endIndex = startIndex + HISTORY_ITEMS_PER_PAGE;
                const pageItems = historyGroupedData.slice(startIndex, endIndex);

                pageItems.forEach(entry => {
                    if (entry.type === 'header') {
                        const header = document.createElement('div');
                        header.className = 'expansion-header';
                        header.innerText = entry.text;
                        grid.appendChild(header);
                    } else {
                        const group = entry.data;
                        const iconUrl = group.icon || 'https://wow.zamimg.com/images/wow/icons/large/inv_misc_questionmark.jpg';

                        const totalCost = group.craftCost * group.totalCount;
                        const profit = group.totalRevenue - totalCost;
                        const profitStr = Math.floor(profit).toLocaleString('uk-UA');

                        const card = document.createElement('div');
                        card.className = 'spell-card';
                        card.onclick = function() { openItemDetails(group.name); };

                        card.innerHTML = 
                            '<div class="spell-icon-frame"><img src="' + iconUrl + '" class="spell-icon"></div>' +
                            '<div class="card-center">' +
                                '<div class="spell-name">' + group.name + '</div>' +
                                '<div class="spell-count-lbl">x' + group.totalCount + ' sold</div>' +
                            '</div>' +
                            '<div class="card-right">' +
                                '<div class="spell-price" title="Profit">' + 
                                    profitStr + ' <img src="https://wow.zamimg.com/images/wow/icons/large/inv_misc_coin_01.jpg" class="coin-icon">' + 
                                '</div>' +
                            '</div>';
                        grid.appendChild(card);
                    }
                });

                // Оновлюємо футер
                document.getElementById('historyPageLabel').innerText = 'PAGE ' + historyCurrentPage + '/' + totalPages;
            }
                
            // Функція фільтрації історії
            function filterHistory() {
                const input = document.getElementById('historySearch');
                const filter = input.value.toLowerCase();
                const grid = document.getElementById('historyGrid');
                const cards = grid.getElementsByClassName('spell-card');

                for (let i = 0; i < cards.length; i++) {
                    const itemName = cards[i].getAttribute('data-name');
                    if (itemName.indexOf(filter) > -1) {
                        cards[i].style.display = "flex";
                    } else {
                        cards[i].style.display = "none";
                    }
                }
            }

            window.openItemDetails = function(itemName) {
                const modal = document.getElementById('itemDetailsModal');
                const listContainer = document.getElementById('detailListContainer');
                document.getElementById('detailItemName').innerText = itemName;
                listContainer.innerHTML = '';

                // Фільтруємо історію
                const itemHistory = currentHistoryData.filter(x => x.item === itemName);
                itemHistory.sort((a, b) => a.timestamp - b.timestamp);

                // --- 1. СПИСОК ---
                const listData = [...itemHistory].reverse(); 
                
                listData.forEach(row => {
                    const totalGold = row.price / 10000;
                    const count = row.count || 1;
                    const priceStr = totalGold.toLocaleString('uk-UA', {maximumFractionDigits: 0});
                    
                    const dateObj = new Date(row.timestamp * 1000);
                    const dateStr = dateObj.toLocaleString('uk-UA', { 
                        day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' 
                    });

                    const rowDiv = document.createElement('div');
                    rowDiv.className = 'sale-row';
                    
                    const countBadge = count > 1 ? '<span style="color:#ffd700; font-weight:bold;">(x'+count+')</span>' : '';
                    
                    rowDiv.innerHTML = 
                        '<div style="display:flex; flex-direction:column;">' +
                            '<span style="color:#ccc; font-weight:bold;">' + row.item + ' ' + countBadge + '</span>' +
                            '<span style="color:#666; font-size:10px;">' + dateStr + '</span>' +
                        '</div>' +
                        '<div style="display:flex; align-items:center; gap:3px; color:#1eff00; font-weight:bold;">' + 
                            priceStr + ' <img src="https://wow.zamimg.com/images/wow/icons/large/inv_misc_coin_01.jpg" style="width:12px; height:12px; border-radius:50%;">' +
                        '</div>';
                    
                    listContainer.appendChild(rowDiv);
                });

                // --- 2. ГРАФІК ---
                const chartLabels = [];
                const chartData = [];
                const groupedMap = {};

                itemHistory.forEach(row => {
                    const dateObj = new Date(row.timestamp * 1000);
                    const key = String(dateObj.getDate()).padStart(2,'0') + "." + String(dateObj.getMonth()+1).padStart(2,'0');
                    
                    if (!groupedMap[key]) groupedMap[key] = { count: 0, totalGold: 0 };
                    groupedMap[key].count += (row.count || 1);
                    groupedMap[key].totalGold += (row.price / 10000);
                });

                Object.keys(groupedMap).forEach(dateKey => {
                    chartLabels.push(dateKey);
                    chartData.push(groupedMap[dateKey].count);
                });

                if (detailChartInstance) detailChartInstance.destroy();
                const ctx = document.getElementById('itemDetailChart').getContext('2d');
                
                detailChartInstance = new Chart(ctx, {
                    type: 'bar',
                    data: {
                        labels: chartLabels,
                        datasets: [{
                            label: 'Sales',
                            data: chartData,
                            backgroundColor: 'rgba(0, 112, 221, 0.5)',
                            borderColor: '#0070dd',
                            borderWidth: 2,
                            barPercentage: 0.5
                        }]
                    },
                    options: {
                        responsive: true, maintainAspectRatio: false,
                        plugins: { 
                            legend: { display: false },
                            tooltip: {
                                displayColors: false,
                                callbacks: {
                                    title: function(ctx) { return 'Date: ' + ctx[0].label; },
                                    label: function(context) {
                                        const dateKey = context.label;
                                        const info = groupedMap[dateKey];
                                        const goldStr = info.totalGold.toLocaleString('uk-UA', {maximumFractionDigits:0});
                                        // ВИПРАВЛЕНО: Використовуємо одинарні лапки + конкатенацію
                                        return [
                                            'Sold: ' + info.count + ' items',
                                            'Total: ' + goldStr + ' Gold'
                                        ];
                                    }
                                }
                            }
                        },
                        scales: {
                            y: { beginAtZero: true, grid: { color: '#333' }, ticks: { color: '#888', stepSize: 1 } },
                            x: { grid: { display: false }, ticks: { color: '#888' } }
                        }
                    }
                });

                modal.classList.add('active');
            }

            window.closeItemDetails = function() {
                document.getElementById('itemDetailsModal').classList.remove('active');
            }

            document.getElementById('btnCloseHistory').onclick = () => { document.getElementById('historyModal').classList.remove('active'); };

            document.addEventListener('DOMContentLoaded', () => {
                reparseAllCharacters(); 
                loadMore();
                updateTopRightSection();
                checkHistorySession(); // Init history button state
                
                document.getElementById('btnLoadMore').onclick = loadMore;
                document.getElementById('smartSearchInput').oninput = handleSearch;
                document.querySelector('.btn-import-addon').onclick = handleAddonImport;
                document.querySelector('.btn-import').onclick = handleReagentsImport;
                document.getElementById('btnOpenCart').onclick = openCart;
                document.getElementById('btnCloseCart').onclick = closeCart;
                
                document.getElementById('cartModal').addEventListener('click', (e) => { if (e.target.id === 'cartModal') closeCart(); });
                document.getElementById('btnReset').addEventListener('click', handleReset);
                document.getElementById('importModal').addEventListener('click', (e) => { if (e.target.id === 'importModal') document.getElementById('importModal').classList.remove('active'); });
                document.getElementById('historyModal').addEventListener('click', (e) => { if (e.target.id === 'historyModal') document.getElementById('historyModal').classList.remove('active'); });
                document.getElementById('charDetailsModal').addEventListener('click', (e) => { if (e.target.id === 'charDetailsModal') document.getElementById('charDetailsModal').classList.remove('active'); });

                // --- НОВИЙ КОД (Кнопки пагінації історії) ---
                document.getElementById('btnHistoryPrev').onclick = () => {
                    if (historyCurrentPage > 1) {
                        historyCurrentPage--;
                        renderHistoryPage();
                    }
                };
                
                document.getElementById('btnHistoryNext').onclick = () => {
                    const totalPages = Math.ceil(historyGroupedData.length / HISTORY_ITEMS_PER_PAGE) || 1;
                    if (historyCurrentPage < totalPages) {
                        historyCurrentPage++;
                        renderHistoryPage();
                    }
                };
            });
        </script>
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