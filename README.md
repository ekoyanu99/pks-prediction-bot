# pks-prediction-bot

Local dashboard for PancakeSwap Prediction automation.

## Modes

- Private key mode: runs the bot on the server and signs transactions with `PRIVATE_KEY` from `.env`.
- Connect wallet mode: runs the bot in the browser through MetaMask or another injected wallet. This avoids storing a private key, but the tab must stay open.

## Run

```bash
npm install
npm start
```

Open `http://127.0.0.1:3000` after the server starts.

## Notes

- Use `privateKey` mode if you want the bot to keep running from the server.
- Use `connect wallet` mode if you want the browser wallet to approve transactions manually.
- Do not expose the dashboard publicly without authentication.
