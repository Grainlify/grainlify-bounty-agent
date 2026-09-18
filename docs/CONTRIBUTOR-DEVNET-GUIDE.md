# Claim a test bounty (about 10 minutes)

Thanks for helping test Grainlify's bounty agent. You'll fix a small issue in a test repo and get paid in **test tokens**.

> **These are devnet test tokens. They have no value and can't be sold.** Nothing here costs you anything, and you never need to buy crypto.
>
> **Never paste a private key or seed phrase anywhere**: not into GitHub, not into chat, not into any website. Nothing in this guide asks you to. If anyone asks for one, it's a scam.

You need a GitHub account and [Node.js](https://nodejs.org) 18 or newer. To check, run `node -v` in a terminal.

---

## 1. Get the helper (one file, no install)

In a terminal:

```bash
curl -fsSLO https://raw.githubusercontent.com/Grainlify/grainlify-bounty-agent/main/tools/grainlify-contributor.mjs
```

It's one short file with no dependencies. You can open it and read it before running it.

## 2. Make a test wallet and sign your link message

Replace `YOUR-GITHUB-USERNAME` with your GitHub username:

```bash
node grainlify-contributor.mjs link YOUR-GITHUB-USERNAME
```

The first time, this creates a **devnet-only wallet** on your computer at `~/.grainlify-devnet/wallet.json`. That file stays on your machine; don't share it. Then the helper prints one line that starts with `/grainlify link`. That line holds a *signature*, not your key, so it's safe to post publicly.

## 3. Post the line as a comment on the bounty issue

1. Open the bounty issue: **https://github.com/Grainlify/grainlify-agent-sandbox/issues/N** (you'll get the exact link).
2. Paste the `/grainlify link …` line as a new comment, from **your own** GitHub account, within 24 hours of running step 2.
3. The Grainlify Agent replies: "linked wallet …". If it says "not linked", the reply explains why. Run step 2 again and post the new line.

## 4. Fix the issue and open a pull request

You can do this entirely on github.com:

1. In the sandbox repo, open the file the issue mentions and click the **pencil icon** (Edit).
2. Make the fix.
3. Click **Commit changes…** → **Propose changes**. GitHub makes a copy (fork) of the repo for you automatically.
4. Click **Create pull request**. In the description, write:
   ```
   Closes #N
   ```
   (the issue number). That line tells the agent which bounty this PR claims.
5. Click **Create pull request**.

The agent posts an automated review comment. It's advisory only. The maintainer then reviews and merges.

## 5. Watch the test tokens arrive

After the maintainer merges and approves the payout, the agent comments on your PR with a transaction link. You can also check any time:

```bash
node grainlify-contributor.mjs balance
```

That prints your balance and an explorer link like
`https://explorer.solana.com/address/<your-wallet>?cluster=devnet`.

Make sure the page says **Devnet**. On mainnet the wallet will look empty, because these tokens exist only on devnet.

---

**Rules the agent checks:**
- one wallet per GitHub account;
- your account must be at least 30 days old;
- you can't merge your own PR;
- one payout per bounty.

**Questions?** Ask the person who sent you this. And again: never share a private key or seed phrase with anyone.
