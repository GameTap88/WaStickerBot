# WhatsApp Sticker Pack Bot

Type one command in any WhatsApp chat and get a full sticker pack back. The bot runs on your own account as a linked device, so there is nothing to host and no account to create.

## Features

- **Full sticker packs on demand** - `.pack Query` for static packs, `.animpack Query` for animated packs
- **Real packs from Sticker.ly** - every pack is one whole pack made by one creator, so the stickers belong together and match the character
- **A different pack every time** - ask for the same character twice and you get a different pack. The bot remembers which ones it already sent and rotates through them, and that memory resets every 24 hours so packs never run out
- **Pick the size** - `.pack Query 20` makes a pack with up to 20 stickers (3-30)
- **Clean replies** - the bot reacts to your message with a snowflake, then sends just the pack. No spam and no extra text
- **Sticker pack card** - sends the native "View sticker pack" card, with a one-tap pack file as a fallback
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
| `.allow` | Let everyone in this chat use the bot |
| `.allow @Friend` | Let one person use the bot |
| `.deny` / `.deny @Friend` | Take access back |

## Setup

1. Install Node.js 18+ and ffmpeg. On Termux: `pkg install nodejs-lts git ffmpeg`
2. Run `npm install`
3. Run `node index.js` and enter your number with the country code, digits only
4. In WhatsApp go to Settings > Linked devices > Link a device > Link with phone number, then enter the 8-character code

After that, send a command in any chat. Next time, just run `node index.js` again. You do not need to link again.

## Notes

- Uses an unofficial WhatsApp library (Baileys). Unofficial clients go against WhatsApp's terms and accounts can be banned, so use it at your own risk.
- Pack data comes from Sticker.ly's unofficial API, which can change or stop working at any time.
- Never share the `auth` folder. It contains your WhatsApp login.
