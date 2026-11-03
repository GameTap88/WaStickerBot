# WhatsApp Sticker Pack Bot

Type one command in any WhatsApp chat and get a full sticker pack back. The bot runs on your own account as a linked device, so there is nothing to host and no account to create.

## Features

- **Full sticker packs on demand** - `.pack Query` for static packs, `.animpack Query` for animated packs
- **Real packs from Sticker.ly** - every pack is one whole pack made by one creator, so the stickers belong together and match the character
- **A different pack every time** - ask for the same character twice and you get a different pack. The bot remembers which ones it already sent and rotates through them, and that memory resets every 24 hours so packs never run out
- **Pick the size** - `.pack Query 20` makes a pack with up to 20 stickers (3-30)
- **Several packs in a row** - `.pack Query 30 5` makes 5 different packs of 30 stickers, one after another (up to 20 at a time, owner only)
- **Clean replies** - the bot reacts to your message with a snowflake, then sends just the pack. No spam and no extra text
- **Sticker pack card** - sends the native "View sticker pack" card, with a one-tap pack file as a fallback
- **Automatic fallbacks** - Sticker.ly is always tried first. If it has nothing, the bot tries Sticko, Sticked, Telegram and Pinterest, in that order (Giphy is optional and off by default), for both static and animated packs
- **Fills incomplete packs** - if a pack is small or unfinished it keeps looking, sends the biggest one it found, and tops it up with animated stickers (or static ones for `.animpack`) to reach the size you asked for. It tells you when it mixed types
- **Tells you where it came from** - a short "From: Sticker.ly" style line after each pack (owner only)
- **Source check** - `.sources Query` tests every source without sending a pack
- **Smart matching** - searches by character or name and only picks packs whose title matches what you asked for
- **Share it with friends** - `.allow @Friend` lets one person use the bot, `.allow` lets a whole chat or group, `.deny` takes it back. Only you control access, and others get a short cooldown so nobody hogs the bot
- **Works with your own account** - link it once with a pairing code, no QR code and no server needed
- **Runs on a phone** - works on Android with Termux, or on any PC with Node.js

## Commands

| Command | What it does |
| --- | --- |
| `.pack Query` | Static sticker pack |
| `.animpack Query` | Animated sticker pack |
| `.pack Query 20` | Pack with a chosen number of stickers |
| `.pack Query 30 5` | 5 different packs of 30 stickers each |
| `.sources Query` | Check which sources can find that name |
| `.abandon` | Stop the pack(s) being made right now (owner only) |
| `.allow` | Let everyone in this chat use the bot |
| `.allow @Friend` | Let one person use the bot |
| `.deny` / `.deny @Friend` | Take access back |

## Setup

1. Install Node.js 18+ and ffmpeg. On Termux: `pkg install nodejs-lts git ffmpeg`
2. Run `npm install`
3. Run `node index.js` and enter your number with the country code, digits only
4. In WhatsApp go to Settings > Linked devices > Link a device > Link with phone number, then enter the 8-character code

5. Optional keys for the fallback sources (each is a one-line file in the bot folder, or an environment variable):
   - Giphy: free key at developers.giphy.com, `echo YOUR_KEY > giphy.key`
   - Telegram: bot token from @BotFather, `echo YOUR_TOKEN > telegram.token`. Works for static packs when the query is an exact pack name, or paste a pack link like `.pack https://t.me/addstickers/PackName`

After that, send a command in any chat. Next time, just run `node index.js` again. You do not need to link again.

## Notes

- Uses an unofficial WhatsApp library (Baileys). Unofficial clients go against WhatsApp's terms and accounts can be banned, so use it at your own risk.
- Pack data comes from Sticker.ly's unofficial API, which can change or stop working at any time.
- Never share the `auth` folder or your key files (`giphy.key`, `telegram.token`). The `auth` folder contains your WhatsApp login.
