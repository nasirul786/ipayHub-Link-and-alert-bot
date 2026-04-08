require('dotenv').config();
const { Bot, session, InlineKeyboard } = require('grammy');
const fs = require('fs');
const path = require('path');

const bot = new Bot(process.env.BOT_TOKEN);
const CHAT_ID = process.env.CHAT_ID;
const MIN_AMOUNT = parseFloat(process.env.MIN_AMOUNT || '10');
const FEE = parseFloat(process.env.FEE || '6');

const CONFIG_FILE = path.join(__dirname, 'config.json');
const COOKIES_FILE = path.join(__dirname, 'cookies.json');

// --- State Management ---
let cancelInProgress = false;

// Load/Save Config
function loadConfig() {
    if (!fs.existsSync(CONFIG_FILE)) {
        fs.writeFileSync(CONFIG_FILE, JSON.stringify({ allowed_users: [], last_completed_id: "" }, null, 2));
    }
    return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'));
}

function saveConfig(data) {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(data, null, 2));
}

function loadCookies() {
    if (!fs.existsSync(COOKIES_FILE)) {
        fs.writeFileSync(COOKIES_FILE, JSON.stringify({ accounts: {}, last_used_index: 0 }, null, 2));
    }
    return JSON.parse(fs.readFileSync(COOKIES_FILE, 'utf-8'));
}

function saveCookies(data) {
    fs.writeFileSync(COOKIES_FILE, JSON.stringify(data, null, 2));
}

function getNextAccount() {
    const data = loadCookies();
    const keys = Object.keys(data.accounts);
    if (keys.length === 0) return null;
    
    let index = data.last_used_index || 0;
    if (index >= keys.length) index = 0;
    
    const accountKey = keys[index];
    const cookie = data.accounts[accountKey];
    
    data.last_used_index = (index + 1) % keys.length;
    saveCookies(data);
    
    return { id: accountKey, cookie };
}

function updateCookie(id, newCookie) {
    const data = loadCookies();
    data.accounts[id] = newCookie;
    saveCookies(data);
}

function addAllowedUser(userId) {
    const config = loadConfig();
    if (!config.allowed_users.includes(userId)) {
        config.allowed_users.push(userId);
        saveConfig(config);
    }
}

// ------ API LOGIC ------ //
let currentCsrfToken = '29f448cc4d23f0eb77a365bb67ff1bd570d6c750a1c77e53c80975b7d1e867b1';

function getHeaders(cookie) {
    return {
        'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
        'accept-language': 'en-US,en;q=0.9,hi;q=0.8,fr;q=0.7',
        'cache-control': 'no-cache',
        'dnt': '1',
        'pragma': 'no-cache',
        'priority': 'u=0, i',
        'sec-ch-ua': '"Chromium";v="146", "Not-A.Brand";v="24", "Google Chrome";v="146"',
        'sec-ch-ua-mobile': '?0',
        'sec-ch-ua-platform': '"Windows"',
        'sec-fetch-dest': 'document',
        'sec-fetch-mode': 'navigate',
        'sec-fetch-site': 'same-origin',
        'sec-fetch-user': '?1',
        'upgrade-insecure-requests': '1',
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36',
        'cookie': cookie
    };
}

async function generateLink(amount, requestedMethod, account) {
    let paymentMethod = 'cashapp';
    if (requestedMethod === 'stripe' || requestedMethod === 'applepay') paymentMethod = 'stripe';
    else if (requestedMethod === 'stripe-card') paymentMethod = 'stripe-card';

    let attempts = 0;
    let currentCookie = account.cookie;

    while (attempts < 3) {
        attempts++;
        const bodyParams = new URLSearchParams({
            custom_points: amount,
            payment_method: paymentMethod,
            csrf_token: currentCsrfToken,
            action: 'save'
        });

        try {
            const fetchHeaders = getHeaders(currentCookie);
            fetchHeaders['content-type'] = 'application/x-www-form-urlencoded';
            fetchHeaders['origin'] = 'https://app.ipayhub.net';
            fetchHeaders['referer'] = 'https://app.ipayhub.net/en/my-account/buy-points';

            const response = await fetch('https://app.ipayhub.net/my-account/buy-points', {
                method: 'POST',
                headers: fetchHeaders,
                body: bodyParams.toString(),
                redirect: 'manual' 
            });

            if (response.status >= 300 && response.status < 400) {
                const loc = response.headers.get('location');
                // Check if session expired or redirected to login
                if (loc.includes('/login') || (loc.includes('/my-account/buy-points') && !loc.includes('/go/'))) {
                     return { expired: true, accId: account.id };
                }
                return { success: true, location: loc, method: paymentMethod };
            } else if (response.status === 200) {
                const text = await response.text();
                // If text contains buy-points but no redirection, or "Login" text, it might be expired
                if (text.includes('Login') || (!text.includes('TOP-') && text.includes('buy-points'))) {
                    // This is simple check, buy-points page without redirect usually means session still there but POST failed or redirection happened to same page
                }

                const csrfMatch = text.match(/<meta name="csrf-token" content="([^"]+)">/);
                if (csrfMatch) currentCsrfToken = csrfMatch[1];

                const setCookieHeader = response.headers.get('set-cookie');
                if (setCookieHeader) {
                    const cookieMatch = setCookieHeader.match(/([^=,\s]+)=([^;]+)/);
                    if (cookieMatch) {
                        const regex = new RegExp(`${cookieMatch[1]}=[^;]+`);
                        if (regex.test(currentCookie)) currentCookie = currentCookie.replace(regex, `${cookieMatch[1]}=${cookieMatch[2]}`);
                        else currentCookie += `; ${cookieMatch[1]}=${cookieMatch[2]}`;
                        updateCookie(account.id, currentCookie);
                    }
                }
                if (attempts >= 3) return { error: 'Failed after 3 attempts' };
            } else {
                return { error: `HTTP ${response.status}` };
            }
        } catch (err) {
            return { error: err.message };
        }
    }
}

async function getStatsForAccount(accId) {
    const data = loadCookies();
    const cookie = data.accounts[accId];
    if (!cookie) return { error: 'Account not found' };

    try {
        const fetchHeaders = getHeaders(cookie);
        fetchHeaders['referer'] = 'https://app.ipayhub.net/en/my-account/dashboard';
        let totalCount = 0, pendingCount = 0, canceledCount = 0, successCount = 0, page = 1;
        while (page <= 50) {
            const response = await fetch(`https://app.ipayhub.net/en/my-account/buy-points?page=${page}`, {
                method: 'GET', headers: fetchHeaders, redirect: 'manual'
            });
            if (response.status >= 300 && response.status < 400) return { error: `Account ${accId} cookie is expired` };
            const text = await response.text();
            if (page === 1) {
                const csrfMatch = text.match(/<meta name="csrf-token" content="([^"]+)">/);
                if (csrfMatch) currentCsrfToken = csrfMatch[1];
            }
            if (text.includes('No purchases found.')) break;
            const rowRegex = /<a href="[^"]*\/o\/(TOP-[A-Z0-9]+)".*?<span class="badge transaction-badge[^>]*>\s*([a-zA-Z]+)\s*<\/span>/gs;
            let match, found = 0;
            while ((match = rowRegex.exec(text)) !== null) {
                found++; totalCount++;
                const status = match[2].trim().toLowerCase();
                if (status === 'pending') pendingCount++;
                else if (status === 'canceled' || status === 'cancelled') canceledCount++;
                else if (status === 'completed' || status === 'success') successCount++;
            }
            if (found === 0) break;
            page++;
        }
        return { success: true, pages_scanned: page - 1, data: { total_orders: totalCount, pending_orders: pendingCount, canceled_orders: canceledCount, success_orders: successCount } };
    } catch (err) { return { error: err.message }; }
}

async function cancelOrdersForAccount(ctx, accId, msgId) {
    const data = loadCookies();
    let currentCookie = data.accounts[accId];
    if (!currentCookie) return;

    try {
        const fetchHeaders = getHeaders(currentCookie);
        fetchHeaders['referer'] = 'https://app.ipayhub.net/en/my-account/buy-points';
        const pendingIds = [];
        let page = 1;

        await ctx.api.editMessageText(ctx.chat.id, msgId, `🔍 Account ${accId}: Scanning for pending orders...`);

        while (page <= 50) {
            const response = await fetch(`https://app.ipayhub.net/en/my-account/buy-points?page=${page}`, { method: 'GET', headers: fetchHeaders, redirect: 'manual' });
            if (response.status >= 300 && response.status < 400) {
                await ctx.api.editMessageText(ctx.chat.id, msgId, `❌ Account ${accId} cookie is expired. Stopping.`);
                return;
            }
            const text = await response.text();
            if (text.includes('No purchases found.')) break;
            const rowRegex = /<a href="[^"]*\/o\/(TOP-[A-Z0-9]+)".*?<span class="badge transaction-badge[^>]*>\s*([a-zA-Z]+)\s*<\/span>/gs;
            let match, found = 0;
            while ((match = rowRegex.exec(text)) !== null) {
                found++;
                if (match[2].trim().toLowerCase() === 'pending') pendingIds.push(match[1]);
            }
            if (found === 0) break;
            page++;
        }

        if (pendingIds.length === 0) {
            await ctx.api.editMessageText(ctx.chat.id, msgId, `✅ Account ${accId}: No pending orders found.`);
            return;
        }

        let canceledCount = 0;
        for (let i = 0; i < pendingIds.length; i++) {
            const id = pendingIds[i];
            await ctx.api.editMessageText(ctx.chat.id, msgId, `🛠 Account ${accId}: Canceling ${i+1}/${pendingIds.length} orders...`);
            
            let success = false;
            let currentUrl = `https://app.ipayhub.net/my-account/buy-points/cancel/${id}`;
            for (let r = 0; r < 3; r++) {
                const res = await fetch(currentUrl, { method: 'GET', headers: getHeaders(currentCookie), redirect: 'manual' });
                if (res.status >= 300 && res.status < 400) {
                    let loc = res.headers.get('location');
                    if (!loc.startsWith('http')) loc = 'https://app.ipayhub.net' + loc;
                    if (loc.includes('/my-account/buy-points') && !loc.includes('/cancel/')) {
                        success = true; canceledCount++; break;
                    }
                    currentUrl = loc;
                } else break;
            }

            // Random delay 10-20 seconds
            if (i < pendingIds.length - 1) {
                const delay = Math.floor(Math.random() * 11) + 10;
                await new Promise(resolve => setTimeout(resolve, delay * 1000));
            }
        }
        await ctx.api.editMessageText(ctx.chat.id, msgId, `✅ Account ${accId}: Finished! Canceled ${canceledCount} orders.`);
    } catch (err) {
        await ctx.api.editMessageText(ctx.chat.id, msgId, `❌ Account ${accId}: Error during cancellation.`);
    }
}

async function getLatestSuccess(lastCompletedId, cookie) {
    try {
        const fetchHeaders = getHeaders(cookie);
        fetchHeaders['referer'] = 'https://app.ipayhub.net/en/my-account/dashboard';
        const newCompletedOrders = [];
        let page = 1, foundLastId = false;

        while (page <= 50 && !foundLastId) {
            const response = await fetch(`https://app.ipayhub.net/en/my-account/buy-points?page=${page}`, { method: 'GET', headers: fetchHeaders, redirect: 'manual' });
            if (response.status >= 300 && response.status < 400) return { error: 'Session expired' };
            const text = await response.text();
            if (text.includes('No purchases found.')) break;
            const rows = text.split('<tr').slice(1);
            let ordersFoundOnCurrentPage = 0;
            for (let row of rows) {
                if (row.includes('<th')) continue;
                ordersFoundOnCurrentPage++;
                const idMatch = row.match(/<a href="[^"]*\/o\/(TOP-[A-Z0-9]+)"/);
                if (!idMatch) continue;
                const id = idMatch[1];
                const statusMatch = row.match(/<span class="badge transaction-badge[^>]*>\s*([a-zA-Z]+)\s*<\/span>/);
                if (!statusMatch) continue;
                const status = statusMatch[1].trim().toLowerCase();
                if (status === 'completed' || status === 'success') {
                    if (lastCompletedId && id === lastCompletedId) {
                        foundLastId = true; break;
                    }
                    const dateMatch = row.match(/>([^<]+)<br>/);
                    const pointsMatch = row.match(/<span class="general-price">([\d.]+)<\/span>/);
                    const usdMatches = Array.from(row.matchAll(/>([\d.]+)\s*USD<\/td>/g));
                    const amount = usdMatches.length > 0 ? usdMatches[0][1] : '0.00';
                    const fee = usdMatches.length > 1 ? usdMatches[1][1] : '0.00';
                    const methodMatch = row.match(/<td>([^<]+)\s*<ul class="list-group">/);
                    const methodStr = methodMatch ? methodMatch[1].trim() : 'Unknown';
                    let paymentLink = `https://app.ipayhub.net/payment/stripe/go/${id}`;
                    if (methodStr.toLowerCase().includes('cashapp')) paymentLink = `https://app.ipayhub.net/en/payment/cashapp/go/${id}`;
                    newCompletedOrders.push({ date: dateMatch ? dateMatch[1].trim() : '', id, points: pointsMatch ? pointsMatch[1] : '0.00', amount, fee, method: methodStr, status, link: paymentLink });
                }
            }
            if (ordersFoundOnCurrentPage === 0) break;
            page++;
        }
        return { success: true, data: newCompletedOrders };
    } catch (err) { return { error: err.message }; }
}

// ------ CRON ALERT LOGIC ------ //
setInterval(async () => {
    try {
        const config = loadConfig();
        const cookies = loadCookies();
        const keys = Object.keys(cookies.accounts);
        if (keys.length === 0) return;

        // Poll using the first account for alerts (or rotate if needed, but one is usually enough for alerts)
        const account = cookies.accounts[keys[0]];
        if (!config.last_completed_id && (!config.allowed_users || config.allowed_users.length === 0)) return; 
        
        const result = await getLatestSuccess(config.last_completed_id, account);
        if (result.success && result.data && result.data.length > 0) {
            for (let i = result.data.length - 1; i >= 0; i--) {
                const txn = result.data[i];
                const msg = `🟢 <b>New Transaction</b> (Acc: ${keys[0]})\n\n` +
                            `<b>ID:</b> ${txn.id}\n` +
                            `<b>Amount:</b> ${txn.amount}\n` +
                            `<b>Points:</b> ${txn.points}\n` +
                            `<b>Fee:</b> ${txn.fee}\n` +
                            `<b>Method:</b> ${txn.method}\n` +
                            `<b>Date:</b> ${txn.date}\n\n` +
                            `<a href="${txn.link}">🔗 View Transaction</a>`;
                if (CHAT_ID) await bot.api.sendMessage(CHAT_ID, msg, { parse_mode: 'HTML', disable_web_page_preview: true }).catch(console.error);
                else {
                    for (const uid of config.allowed_users) bot.api.sendMessage(uid, msg, { parse_mode: 'HTML', disable_web_page_preview: true }).catch(console.error);
                }
                config.last_completed_id = txn.id;
            }
            saveConfig(config);
        }
    } catch (e) { console.error("Alert interval error:", e); }
}, 60000);

// ------ BOT LOGIC ------ //
bot.use(session({
    initial: () => ({ isAuthenticating: false })
}));

bot.command('start', async (ctx) => {
    const config = loadConfig();
    const userId = ctx.from.id;
    if (config.allowed_users.includes(userId)) {
        await ctx.reply("Welcome back! 👋\n\nGenerated links will now rotate between accounts.", { parse_mode: "HTML" });
    } else {
        const keyboard = new InlineKeyboard().text("Authenticate", "authenticate");
        await ctx.reply("Welcome! You are not authenticated. 🚫", { reply_markup: keyboard });
    }
});

bot.callbackQuery('authenticate', async (ctx) => {
    ctx.session.isAuthenticating = true;
    await ctx.answerCallbackQuery();
    await ctx.reply("Please send me the secret PIN: 🔐");
});

bot.command('stats', async (ctx) => {
    const config = loadConfig();
    if (!config.allowed_users.includes(ctx.from.id)) return ctx.reply("You are not authenticated! 🚫");
    
    const cookies = loadCookies();
    const keys = Object.keys(cookies.accounts);
    if (keys.length === 0) return ctx.reply("No accounts found.");

    const keyboard = new InlineKeyboard();
    for (let i = 0; i < keys.length; i++) {
        keyboard.text(keys[i], `stats_acc_${keys[i]}`);
        if ((i + 1) % 3 === 0) keyboard.row();
    }
    await ctx.reply("Select account for stats:", { reply_markup: keyboard });
});

bot.callbackQuery(/^stats_acc_(.+)$/, async (ctx) => {
    const accId = ctx.match[1];
    await ctx.answerCallbackQuery();
    await ctx.editMessageText(`Fetching stats for account ${accId}... ⏳`);
    const data = await getStatsForAccount(accId);
    if (data.success) {
        const stats = data.data;
        const text = `📊 <b>Stats (Acc: ${accId})</b>\n\n` +
            `🔍 Pages: ${data.pages_scanned}\n` +
            `📦 Total: ${stats.total_orders}\n` +
            `⏳ Pending: ${stats.pending_orders}\n` +
            `✅ Success: ${stats.success_orders}\n` +
            `❌ Canceled: ${stats.canceled_orders}`;
        await ctx.editMessageText(text, { parse_mode: "HTML" });
    } else {
        await ctx.editMessageText(`❌ Error: ${data.error}`);
    }
});

bot.command('cancel_pending', async (ctx) => {
    const config = loadConfig();
    if (!config.allowed_users.includes(ctx.from.id)) return ctx.reply("You are not authenticated! 🚫");
    
    if (cancelInProgress) return ctx.reply("⚠️ Previous cancel in progress. Please wait.");

    const cookies = loadCookies();
    const keys = Object.keys(cookies.accounts);
    if (keys.length === 0) return ctx.reply("No accounts found.");

    const keyboard = new InlineKeyboard();
    for (let i = 0; i < keys.length; i++) {
        keyboard.text(keys[i], `cancel_acc_${keys[i]}`);
        if ((i + 1) % 3 === 0) keyboard.row();
    }
    await ctx.reply("Select account to cancel pending orders:", { reply_markup: keyboard });
});

bot.callbackQuery(/^cancel_acc_(.+)$/, async (ctx) => {
    const accId = ctx.match[1];
    if (cancelInProgress) return ctx.answerCallbackQuery("Previous cancel in progress!");
    
    cancelInProgress = true;
    await ctx.answerCallbackQuery();
    const msg = await ctx.reply(`Starting background cancellation for account ${accId}... ⏳`);
    
    cancelOrdersForAccount(ctx, accId, msg.message_id).finally(() => {
        cancelInProgress = false;
    });
});

bot.command('cookie', async (ctx) => {
    const config = loadConfig();
    if (!config.allowed_users.includes(ctx.from.id)) return;
    
    const parts = ctx.message.text.split(' ');
    // /cookie <text> <number>
    if (parts.length < 2) return ctx.reply("Usage: /cookie <text> [number]");
    
    const cookieText = parts[1];
    const number = parts[2];
    
    const data = loadCookies();
    if (number && data.accounts[number]) {
        data.accounts[number] = cookieText;
        saveCookies(data);
        await ctx.reply(`✅ Account ${number} cookie updated.`);
    } else {
        const nextNum = Object.keys(data.accounts).length + 1;
        data.accounts[nextNum.toString()] = cookieText;
        saveCookies(data);
        await ctx.reply(`✅ New cookie added as Account ${nextNum}.`);
    }
});

bot.on('message:text', async (ctx) => {
    const userId = ctx.from.id;
    const config = loadConfig();
    
    if (ctx.session.isAuthenticating) {
        if (ctx.message.text === process.env.BOT_PASSWORD) {
            addAllowedUser(userId);
            ctx.session.isAuthenticating = false;
            await ctx.reply("Authentication successful! ✅");
        } else {
            ctx.session.isAuthenticating = false;
            await ctx.reply("Incorrect PIN. ❌");
        }
        return;
    }
    
    if (config.allowed_users.includes(userId)) {
        const text = ctx.message.text.trim();
        if (text.startsWith('$')) {
            const amountStr = text.substring(1).trim();
            const amount = parseFloat(amountStr);
            if (isNaN(amount) || amount < MIN_AMOUNT) return ctx.reply(`❌ Min amount is $${MIN_AMOUNT}`);
            const keyboard = new InlineKeyboard().text("CashApp", `method_cashapp_${amountStr}`).text("Stripe", `method_stripe_${amountStr}`);
            await ctx.reply(`Amount: $${amountStr}. Select method:`, { reply_markup: keyboard });
        }
    }
});

bot.callbackQuery(/^method_(cashapp|stripe)_(.+)$/, async (ctx) => {
    const config = loadConfig();
    if (!config.allowed_users.includes(ctx.from.id)) return ctx.answerCallbackQuery();
    
    const method = ctx.match[1];
    const amountStr = ctx.match[2];
    await ctx.answerCallbackQuery();
    
    const totalAmount = parseFloat(amountStr);
    const finalAmount = (totalAmount / (1 + (FEE / 100))).toFixed(2);

    const cookiesBefore = loadCookies();
    const accountCount = Object.keys(cookiesBefore.accounts).length;
    let attempts = 0;
    let success = false;

    while (attempts < accountCount && !success) {
        attempts++;
        // Reload cookies from file every attempt to ensure manual updates are picked up
        const currentData = loadCookies();
        const account = getNextAccount(); 
        if (!account) return ctx.editMessageText("❌ No accounts configured.");

        await ctx.editMessageText(`Generating link (Acc: ${account.id})... ⏳`);
        
        try {
            const data = await generateLink(finalAmount, method, account);
            
            if (data.expired) {
                await ctx.reply(`❌ Account ${data.accId} cookie is expired, trying next...`);
                // Continue to next account
            } else if (data.success && data.location) {
                let paymentLink = data.location;
                if (!paymentLink.startsWith('http')) paymentLink = 'https://app.ipayhub.net' + paymentLink;
                
                await ctx.editMessageText(`💳 Link for $${amountStr} (${method}) [Acc: ${account.id}]:\n\n🔗 ${paymentLink}`, { disable_web_page_preview: true });
                success = true;
            } else {
                await ctx.editMessageText(`❌ Error (Acc: ${account.id}): ${data.error || 'Unknown'}`);
                return; // Stop on serious errors
            }
        } catch (e) {
            await ctx.editMessageText(`❌ Exception (Acc: ${account.id})`);
            return;
        }
    }

    if (!success) {
        await ctx.reply("❌ All configured accounts have expired cookies. Please update them.");
    }
});

bot.catch((err) => console.error(err));
bot.start();
console.log("Bot running...");
