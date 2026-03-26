# iPayHub Link & Alert Bot

A Telegram bot built with Node.js and Grammy to automate iPayHub operations natively. The bot generates payment links, fetches order statistics, auto-cancels pending orders efficiently without blocking user interaction, and natively polls for new success occurrences to send real-time alerts.

## Features
- **Native Operations**: Everything (cookie handling, DOM scraping, HTTP queries) runs internally directly from Node.js (no external express APIs or PHP wrapper scripts needed).
- **Asynchronous Processing**: Background jobs like canceling pending orders run concurrently; the bot remains responsive to other users and commands.
- **Bot Alert Poller**: Background interval checks for new completed transactions every minute and flashes real-time updates directly to a configured chat ID.
- **Configurable Access**: Easily whitelist specific Telegram User IDs to securely lock down access via an encrypted `.env` PIN and `config.json`.
- **Direct Links**: Directly serves `https://app.ipayhub.net/...` checkout endpoints without the need for proxy intermediate domain parameters (`p` or `s`).

## Prerequisites
- **Node.js**: v18 or newer (required for native `fetch`).
- A valid Telegram Bot Token from [@BotFather](https://t.me/BotFather).

## Setup Guide

1. **Clone or Download the Code**:
   Bring the source code into your environment and install dependencies:
   ```bash
   npm install
   ```

2. **Configure Environment Variables**:
   In the root directory, create a `.env` file containing:
   ```env
   BOT_TOKEN=your_telegram_bot_token_here
   BOT_PASSWORD=YOURSECRET_PIN
   CHAT_ID=your_admin_or_group_chat_id_for_alerts
   ```
   *Replace `BOT_TOKEN`, `BOT_PASSWORD`, and `CHAT_ID` with your actual information.*

3. **Provide iPayHub Session Cookie**:
   The bot interacts with iPayHub using a browser session. You must supply your session cookie.
   - Create a file named `cookie.txt` in the root of the project.
   - Paste your authenticated iPayHub `cookie` string (e.g. `2WayWeb=xyz...`) inside the file.

4. **Initialize Config File (Optional)**:
   The bot automatically auto-generates a `config.json` on the first run.
   Alternatively, you can manually create it to preload allowed users:
   ```json
   {
     "allowed_users": [123456789],
     "last_completed_id": ""
   }
   ```

## Running the Bot

Start the bot with:
```bash
node index.js
```
The console will display `Bot is running...` if it starts correctly.

## Usage

Send the `/start` command to the bot in Telegram. 
- If you are unauthenticated, click **Authenticate** and supply the exact `BOT_PASSWORD` value.
- Once authenticated, you can send amounts starting with `$` (example: `$90`) to generate direct CashApp or Stripe links.
- Use `/stats` to retrieve an up-to-date summary of your pending, completed, or canceled orders.
- Use `/cancel_pending` to scan backwards and asynchronously clean up any stale pending checkout invoices!
