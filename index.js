require('dotenv').config();
const { Bot, session, InlineKeyboard } = require('grammy');
const fs = require('fs');
const path = require('path');

const bot = new Bot(process.env.BOT_TOKEN);
const CHAT_ID = process.env.CHAT_ID;
const MIN_AMOUNT = parseFloat(process.env.MIN_AMOUNT || '10');
const FEE = parseFloat(process.env.FEE || '6');

const CONFIG_FILE = path.join(__dirname, 'config.json');
const COOKIE_FILE = path.join(__dirname, 'cookie.txt');

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

function addAllowedUser(userId) {
    const config = loadConfig();
    if (!config.allowed_users.includes(userId)) {
        config.allowed_users.push(userId);
        saveConfig(config);
    }
}

// ------ API LOGIC ------ //
let currentCsrfToken = '29f448cc4d23f0eb77a365bb67ff1bd570d6c750a1c77e53c80975b7d1e867b1';

function getCookie() {
    try {
        if (!fs.existsSync(COOKIE_FILE)) return null;
        const cookie = fs.readFileSync(COOKIE_FILE, 'utf8').trim();
        return cookie || null;
    } catch (err) {
        return null;
    }
}

function saveCookie(newCookieString) {
    try {
        fs.writeFileSync(COOKIE_FILE, newCookieString, 'utf8');
    } catch (err) { }
}

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

async function generateLink(amount, requestedMethod) {
    let paymentMethod = 'cashapp';
    if (requestedMethod === 'stripe' || requestedMethod === 'applepay') paymentMethod = 'stripe';
    else if (requestedMethod === 'stripe-card') paymentMethod = 'stripe-card';

    let attempts = 0;
    while (attempts < 3) {
        attempts++;
        let currentCookie = getCookie();
        if (!currentCookie) return { error: 'cookie.txt missing' };

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
                return { success: true, location: response.headers.get('location'), method: paymentMethod };
            } else if (response.status === 200) {
                const text = await response.text();
                const csrfMatch = text.match(/<meta name="csrf-token" content="([^"]+)">/);
                if (csrfMatch) currentCsrfToken = csrfMatch[1];

                const setCookieHeader = response.headers.get('set-cookie');
                if (setCookieHeader) {
                    const cookieMatch = setCookieHeader.match(/([^=,\s]+)=([^;]+)/);
                    if (cookieMatch) {
                        const cookieName = cookieMatch[1];
                        const cookieValue = cookieMatch[2];
                        const regex = new RegExp(`${cookieName}=[^;]+`);
                        if (regex.test(currentCookie)) currentCookie = currentCookie.replace(regex, `${cookieName}=${cookieValue}`);
                        else currentCookie += `; ${cookieName}=${cookieValue}`;
                        saveCookie(currentCookie);
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

async function getPendingOrders() {
    let currentCookie = getCookie();
    if (!currentCookie) return { error: 'cookie.txt missing' };

    try {
        const fetchHeaders = getHeaders(currentCookie);
        fetchHeaders['referer'] = 'https://app.ipayhub.net/en/my-account/dashboard';

        let totalCount = 0, pendingCount = 0, canceledCount = 0, successCount = 0, page = 1;
        
        while (page <= 50) {
            const response = await fetch(`https://app.ipayhub.net/en/my-account/buy-points?page=${page}`, {
                method: 'GET', headers: fetchHeaders, redirect: 'manual'
            });

            if (response.status >= 300 && response.status < 400) return { error: `Session expired` };
            const text = await response.text();
            if (page === 1) {
                const csrfMatch = text.match(/<meta name="csrf-token" content="([^"]+)">/);
                if (csrfMatch) currentCsrfToken = csrfMatch[1];
            }
            if (text.includes('No purchases found.')) break;

            const rowRegex = /<a href="[^"]*\/o\/(TOP-[A-Z0-9]+)".*?<span class="badge transaction-badge[^>]*>\s*([a-zA-Z]+)\s*<\/span>/gs;
            let match;
            let found = 0;
            
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
    } catch (err) {
        return { error: err.message };
    }
}

async function cancelAllOrders() {
    const startTime = Date.now();
    const TIME_LIMIT_MS = 55000;
    let currentCookie = getCookie();
    if (!currentCookie) return { error: 'cookie.txt missing' };

    try {
        const fetchHeaders = getHeaders(currentCookie);
        fetchHeaders['referer'] = 'https://app.ipayhub.net/en/my-account/buy-points';

        const pendingIds = [];
        let page = 1;
        while (page <= 50) {
            if (Date.now() - startTime >= TIME_LIMIT_MS) break;
            const response = await fetch(`https://app.ipayhub.net/en/my-account/buy-points?page=${page}`, { method: 'GET', headers: fetchHeaders, redirect: 'manual' });
            if (response.status >= 300 && response.status < 400) return { error: 'Session expired' };
            const text = await response.text();
            if (page === 1) {
                const csrfMatch = text.match(/<meta name="csrf-token" content="([^"]+)">/);
                if (csrfMatch) currentCsrfToken = csrfMatch[1];
            }
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

        let canceledCount = 0, failedCount = 0, currentIndex = 0;
        
        while (currentIndex < pendingIds.length) {
            if (Date.now() - startTime >= TIME_LIMIT_MS) break;
            const id = pendingIds[currentIndex];
            let successForThisId = false;

            for (let attempt = 0; attempt < 3 && !successForThisId; attempt++) {
                let currentUrl = `https://app.ipayhub.net/my-account/buy-points/cancel/${id}`;
                for (let r = 0; r < 3; r++) {
                    const cancelRes = await fetch(currentUrl, { method: 'GET', headers: getHeaders(currentCookie), redirect: 'manual' });
                    if (cancelRes.status >= 300 && cancelRes.status < 400) {
                        let loc = cancelRes.headers.get('location');
                        if (!loc.startsWith('http')) loc = 'https://app.ipayhub.net' + loc;
                        if (loc.includes('/my-account/buy-points') && !loc.includes('/cancel/')) {
                            successForThisId = true; canceledCount++; break;
                        }
                        currentUrl = loc;
                    } else if (cancelRes.status === 200) {
                        const cancelText = await cancelRes.text();
                        const csrfMatch = cancelText.match(/<meta name="csrf-token" content="([^"]+)">/);
                        if (csrfMatch) currentCsrfToken = csrfMatch[1];
                        const setCookieHeader = cancelRes.headers.get('set-cookie');
                        if (setCookieHeader) {
                            const cookieMatch = setCookieHeader.match(/([^=,\s]+)=([^;]+)/);
                            if (cookieMatch) {
                                const regex = new RegExp(`${cookieMatch[1]}=[^;]+`);
                                if (regex.test(currentCookie)) currentCookie = currentCookie.replace(regex, `${cookieMatch[1]}=${cookieMatch[2]}`);
                                else currentCookie += `; ${cookieMatch[1]}=${cookieMatch[2]}`;
                                saveCookie(currentCookie);
                            }
                        }
                        break;
                    } else break;
                }
            }
            if (!successForThisId) failedCount++;
            currentIndex++;
        }

        return {
            success: true,
            time_taken_seconds: ((Date.now() - startTime)/1000).toFixed(2),
            total_pending_found: pendingIds.length,
            successfully_canceled: canceledCount,
            failed_to_cancel: failedCount,
            left_to_cancel: pendingIds.length - currentIndex,
            timeout_reached: currentIndex < pendingIds.length
        };
    } catch (err) { return { error: err.message }; }
}

async function getLatestSuccess(lastCompletedId) {
    let currentCookie = getCookie();
    if (!currentCookie) return { error: 'cookie.txt missing' };

    try {
        const fetchHeaders = getHeaders(currentCookie);
        fetchHeaders['referer'] = 'https://app.ipayhub.net/en/my-account/dashboard';
        const newCompletedOrders = [];
        let page = 1, foundLastId = false;

        while (page <= 50 && !foundLastId) {
            const response = await fetch(`https://app.ipayhub.net/en/my-account/buy-points?page=${page}`, { method: 'GET', headers: fetchHeaders, redirect: 'manual' });
            if (response.status >= 300 && response.status < 400) return { error: 'Session expired' };
            const text = await response.text();
            if (page === 1) {
                const csrfMatch = text.match(/<meta name="csrf-token" content="([^"]+)">/);
                if (csrfMatch) currentCsrfToken = csrfMatch[1];
            }
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
                    if (methodStr.toLowerCase().includes('cashapp')) {
                        paymentLink = `https://app.ipayhub.net/en/payment/cashapp/go/${id}`;
                    }

                    newCompletedOrders.push({
                        date: dateMatch ? dateMatch[1].trim() : '',
                        id: id, points: pointsMatch ? pointsMatch[1] : '0.00',
                        amount, fee, method: methodStr, status, link: paymentLink
                    });
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
        // Prevent initial blast if none saved or no one to send to
        if (!config.last_completed_id && (!config.allowed_users || config.allowed_users.length === 0)) return; 
        
        const result = await getLatestSuccess(config.last_completed_id);
        if (result.success && result.data && result.data.length > 0) {
            for (let i = result.data.length - 1; i >= 0; i--) { // Process from oldest to newest
                const txn = result.data[i];
                const msg = `🟢 <b>New Transaction</b>\n\n` +
                            `<b>ID:</b> ${txn.id}\n` +
                            `<b>Amount:</b> ${txn.amount}\n` +
                            `<b>Points:</b> ${txn.points}\n` +
                            `<b>Fee:</b> ${txn.fee}\n` +
                            `<b>Method:</b> ${txn.method}\n` +
                            `<b>Date:</b> ${txn.date}\n\n` +
                            `<a href="${txn.link}">🔗 View Transaction</a>`;
                
                if (CHAT_ID) {
                    await bot.api.sendMessage(CHAT_ID, msg, { parse_mode: 'HTML', disable_web_page_preview: true }).catch(console.error);
                } else if (config.allowed_users && config.allowed_users.length > 0) {
                    // Send to all allowed users if CHAT_ID not set
                    for (const uid of config.allowed_users) {
                        bot.api.sendMessage(uid, msg, { parse_mode: 'HTML', disable_web_page_preview: true }).catch(console.error);
                    }
                }
                config.last_completed_id = txn.id;
            }
            saveConfig(config);
        }
    } catch (e) {
        console.error("Alert interval error:", e);
    }
}, 60000); // 1 minute

// ------ BOT LOGIC ------ //
bot.use(session({
    initial: () => ({ isAuthenticating: false })
}));

bot.command('start', async (ctx) => {
    const config = loadConfig();
    const userId = ctx.from.id;

    if (config.allowed_users.includes(userId)) {
        await ctx.reply(
            "Welcome back! 👋\n\n" +
            "Here is how to use this bot:\n" +
            "• <b>Generate Link</b>: Send an amount starting with <code>$</code> (example: <code>$90</code>)\n" +
            "• /stats: View your order statistics\n" +
            "• /cancel_pending: Cancel all pending orders",
            { parse_mode: "HTML" }
        );
    } else {
        const keyboard = new InlineKeyboard().text("Authenticate", "authenticate");
        await ctx.reply("Welcome! You are not authenticated. 🚫\n\nPlease authenticate to use this bot.", { reply_markup: keyboard });
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
    
    try {
        const msg = await ctx.reply("Fetching your statistics... ⏳");
        const data = await getPendingOrders();
        
        if (data.success) {
            const stats = data.data;
            const text = `📊 <b>Stats</b>\n\n` +
                `🔍 Pages Scanned: ${data.pages_scanned}\n` +
                `📦 Total Orders: ${stats.total_orders}\n` +
                `⏳ Pending Orders: ${stats.pending_orders}\n` +
                `✅ Success Orders: ${stats.success_orders}\n` +
                `❌ Canceled Orders: ${stats.canceled_orders}`;
            await ctx.api.editMessageText(ctx.chat.id, msg.message_id, text, { parse_mode: "HTML" });
        } else {
            await ctx.api.editMessageText(ctx.chat.id, msg.message_id, `❌ Error: ${data.error}`);
        }
    } catch (e) {
        await ctx.reply("❌ An error occurred while fetching stats.");
    }
});

bot.command('cancel_pending', async (ctx) => {
    const config = loadConfig();
    if (!config.allowed_users.includes(ctx.from.id)) return ctx.reply("You are not authenticated! 🚫");
    
    try {
        const msg = await ctx.reply("Canceling pending orders... ⏳\n(This runs in background, I am free to reply to other messages!)");
        
        // Run cancellation asynchronously without awaiting it here
        cancelAllOrders().then(async (data) => {
            if (data.success) {
                let text = `🛑 <b>Cancel Pending Results</b>\n\n` +
                    `⏱ Time Taken: ${data.time_taken_seconds}s\n` +
                    `🔍 Total Found: ${data.total_pending_found}\n` +
                    `✅ Successfully Canceled: ${data.successfully_canceled}\n` +
                    `❌ Failed to Cancel: ${data.failed_to_cancel}\n` +
                    `⏳ Left to Cancel: ${data.left_to_cancel}\n\n`;
                
                if (data.timeout_reached) text += `⚠️ <b>Timeout reached!</b> Run /cancel_pending again.`;
                else text += `🎉 Finished processing!`;
                
                await ctx.api.editMessageText(ctx.chat.id, msg.message_id, text, { parse_mode: "HTML" });
            } else {
                await ctx.api.editMessageText(ctx.chat.id, msg.message_id, `❌ Error: ${data.error}`);
            }
        }).catch(async (e) => {
            await ctx.api.editMessageText(ctx.chat.id, msg.message_id, "❌ Exception while cancelling");
        });
        
    } catch (e) {
        await ctx.reply("❌ An error occurred initiating cancel.");
    }
});

bot.on('message:text', async (ctx) => {
    const userId = ctx.from.id;
    const config = loadConfig();
    
    if (ctx.session.isAuthenticating) {
        if (ctx.message.text === process.env.BOT_PASSWORD) {
            addAllowedUser(userId);
            ctx.session.isAuthenticating = false;
            await ctx.reply("Authentication successful! ✅\n\nNow, send any amount with a $ sign (for example: $90) to generate a payment link.");
        } else {
            ctx.session.isAuthenticating = false;
            await ctx.reply("Incorrect PIN. ❌ Authentication failed.");
        }
        return;
    }
    
    if (config.allowed_users.includes(userId)) {
        const text = ctx.message.text.trim();
        if (text.startsWith('$')) {
            const amountStr = text.substring(1).trim();
            const amount = parseFloat(amountStr);
            if (isNaN(amount) || amount <= 0) return ctx.reply("Please provide a valid amount! ✨ Example: $90");
            
            if (amount < MIN_AMOUNT) {
                return ctx.reply(`❌ Minimum amount is $${MIN_AMOUNT}. Please provide a higher amount.`);
            }
            
            const keyboard = new InlineKeyboard()
                .text("CashApp", `method_cashapp_${amountStr}`)
                .text("Stripe (ApplePay)", `method_stripe_${amountStr}`);
            await ctx.reply(`You entered $${amountStr}. Please select a payment method:`, { reply_markup: keyboard });
        } else {
            await ctx.reply("Please send an amount starting with $ (e.g. $90) to generate a payment link. 💡");
        }
    } else {
        await ctx.reply("You are not authenticated! 🚫\nType /start to authenticate.");
    }
});

bot.callbackQuery(/^method_(cashapp|stripe)_(.+)$/, async (ctx) => {
    const config = loadConfig();
    if (!config.allowed_users.includes(ctx.from.id)) return ctx.answerCallbackQuery("Not authenticated");
    
    const method = ctx.match[1];
    const amountStr = ctx.match[2];
    await ctx.answerCallbackQuery();
    
    try {
        await ctx.editMessageText(`Generating your payment link... ⏳ (${method})`);
        
        // Calculate amount after deducting 6% fee (X / 1.06)
        const totalAmount = parseFloat(amountStr);
        const feePercentage = FEE / 100;
        const baseAmount = totalAmount / (1 + feePercentage);
        const finalAmount = baseAmount.toFixed(2);

        const data = await generateLink(finalAmount, method);
        
        if (data.success && data.location) {
            let paymentLink = data.location;
            if (!paymentLink.startsWith('http')) paymentLink = 'https://app.ipayhub.net' + paymentLink;
            
            await ctx.editMessageText(
                `💳 Here is your payment link for $${amountStr} (${method}):\n\n🔗 ${paymentLink}`,
                { parse_mode: "HTML", disable_web_page_preview: true }
            );
        } else {
            await ctx.editMessageText(`❌ Error generating link: ${data.error || 'Unknown'}`);
        }
    } catch (e) {
        await ctx.editMessageText("❌ An error occurred while generating the payment link.");
    }
});

bot.catch((err) => {
    console.error("Bot Error: ", err);
});

bot.start();
console.log("Bot is running...");
