# iPayHub Link & Alert Bot

A Telegram bot built with Node.js and Grammy to automate iPayHub operations natively. The bot generates payment links, fetches order statistics, auto-cancels pending orders efficiently, and natively polls for new success occurrences across multiple accounts.

## Features
- **Multi-Account Support**: Rotate between multiple iPayHub accounts automatically or select specific ones for management.
- **Failover Link Generation**: Automatically retires links on alternative accounts if a session is expired until a working one is found.
- **Native Operations**: Everything runs internally directly from Node.js (no external scripts needed).
- **Asynchronous Processing**: Background jobs like canceling pending orders run with randomized human-like delays (10-20s) without blocking the bot.
- **Bot Alert Poller**: Background checks for new completed transactions every minute.
- **Configurable Access**: Whitelist specific Telegram User IDs via `.env` and `config.json`.
- **Fee Management**: Automatically calculates amounts to account for Payment Gateway fees (e.g., 6%).

## Prerequisites
- **Node.js**: v18 or newer.
- A valid Telegram Bot Token.

## Setup Guide

1. **Install Dependencies**:
   ```bash
   npm install
   ```

2. **Configure Environment Variables**:
   Create a `.env` file:
   ```env
   BOT_TOKEN=your_token
   BOT_PASSWORD=your_pin
   CHAT_ID=your_alert_chat_id
   MIN_AMOUNT=10
   FEE=6
   ```

3. **Manage Accounts (`cookies.json`)**:
   The bot uses `cookies.json` to manage multiple accounts.
   Format:
   ```json
   {
     "accounts": {
       "1": "2WayWeb=cookie_here",
       "2": "2WayWeb=another_cookie"
     },
     "last_used_index": 0
   }
   ```
   You can add or update cookies directly via Telegram using `/cookie <text> [number]`.

## Commands
- `/start`: Authenticate with the bot.
- `/stats`: Select an account to view transaction statistics.
- `/cancel_pending`: Select an account to background-cancel pending orders with random delays.
- `/cookie <text> [number]`: Update or add a new iPayHub session cookie.
- `$amount`: Generate a payment link (e.g., `$100`).

## Running the Bot
```bash
node index.js
```
