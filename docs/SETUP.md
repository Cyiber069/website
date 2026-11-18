# ACX Agent: set up once

About 30 minutes. You need your laptop, your Cloudflare login and your GitHub login.

## 1. Put the dashboard online (Cloudflare, about 5 minutes)

1. Open dash.cloudflare.com and go to **Workers & Pages**, then **Create**, then **Import a repository**.
2. Connect GitHub when asked and pick the `website` repository.
3. Set the branch to `claude/brave-mccarthy-rp1440` (or `main` once this work is merged). If the first screen has no branch choice, finish creating it, then change it under **Settings, Build, Branch control**.
4. Leave the build command empty. Deploy command: `npx wrangler deploy`. Press **Save and Deploy**.
5. If the build fails with a database permission error: open **Settings, Build, API token**, add **Account, D1, Edit** to the token, and press **Retry build**.
6. When it finishes, copy your site address. It looks like `https://acxagent.<your-name>.workers.dev`.
7. Open that address and choose a password. Do this straight away: whoever opens it first sets the password.

The database (`acx-agent`) already exists in your Cloudflare account and the site creates its own tables on first visit.

## 2. Install the extension on the laptop (about 5 minutes)

1. On GitHub open the repository, switch to the branch above, press **Code**, then **Download ZIP**. Unzip it somewhere you will not delete, for example Documents.
2. In Chrome open `chrome://extensions`. Switch on **Developer mode** (top right) and leave it on.
3. Press **Load unpacked** and choose the `extension` folder inside the unzipped folder.
4. Pin "ACX Agent" to the toolbar.
5. In the dashboard open **Connections** and press **Pair this laptop**. Copy the pairing line.
6. Click the ACX Agent icon in Chrome, paste the line, press **Connect**.

## 3. Open and log in to the three sites

The extension opens WhatsApp Web, Gmail and TikTok messages as pinned tabs. Log in to each one.

* **WhatsApp:** scan the QR code with the shop phone. Keep only one WhatsApp Web tab.
* **Gmail:** Settings, General: Conversation view **on**, Language **English**, Undo Send **5 seconds**. Settings, Inbox: Reading pane **No split**, Inbox type **Default**.
* **TikTok:** use `tiktok.com/messages` (not Business Suite), language English. In TikTok privacy settings let messages go to your Inbox so customers skip the request step.

Then click the extension icon, open **More**, press **Run a check**. It tests each tab without sending anything. Send the result to Claude if anything says FAIL.

## 4. Keep the laptop awake

* Plug it in. Set sleep to **Never** and "when I close the lid" to **Do nothing** (Windows: Control Panel, Power Options. Mac: System Settings, Battery, Options, and keep the lid open).
* Chrome: `chrome://settings/performance`, add `web.whatsapp.com`, `mail.google.com` and `www.tiktok.com` under **Always keep these sites active**. Turn Energy Saver off.
* Keep the Chrome window open and not minimised.
* Set Chrome to open at login and to "Continue where you left off".

## 5. Give it a brain

It works straight away on Cloudflare's free AI (a few hundred short replies a day). For better replies paste a Claude API key from console.anthropic.com in **Connections, AI brain** and press **Test**. Claude is billed per use by Anthropic.

Photos and videos: the free AI cannot see them. Make a key at aistudio.google.com (Get API key, on a project with billing on), paste it in **Connections, Google AI Studio**, press **Save**, then **Test key**. From then on the agent gets a short note of what each photo or video shows and can answer it. Unclear photos, damage, faults and safety problems still come to you in Urgent. **Most videos a day** caps the whole videos it watches (20); after that it looks at a few pictures from each one. In aistudio.google.com/logs you can also switch off request logging for the project. Google bills per use.

## 6. Teach it

**Knowledge** already holds your products, policies and FAQs from the store. Answer the "teach me" cards: they are the questions customers ask that your store does not answer. Upload any other files there.

Use **Voice** and its playground to see how it replies before it talks to real customers.

## 7. Connect AcxEbikes (for the 20:00 checkout messages)

**Full connect (recommended)**

1. Shopify admin, **Settings, Apps, Develop apps, Build apps in Dev Dashboard**.
2. **Create app**, name it "ACX Agent".
3. On Versions set App URL to `https://shopify.dev/apps/default-app-home`, Webhooks API version `2026-10`, and Scopes `read_orders,read_all_orders,read_customers,read_products,write_discounts` (`write_discounts` lets the **Discount codes** screen make codes for you).
4. Press **Release**, then **Release** again.
5. On the app overview press **Install app**, pick the store, **Install**.
6. In the app's Settings copy the **Client ID** and **Client secret**.
7. Paste both in the dashboard under **Connections, Shopify**. Save, then **Test**.

**Quick connect** (sees only checkouts from now on): the dashboard's Shopify card shows a webhook address. In Shopify admin, **Settings, Notifications, Webhooks**, create three webhooks to that address (Checkout creation, Checkout update, Order creation; JSON; version 2026-10), then paste the signing key shown on that page into the dashboard.

## 8. Checkout reminders

Open **Recovery**, type roughly what you want to say, press **Suggest**, edit, then approve and choose who gets it. Nothing is sent until you approve. Until then 20:00 only records what it would have sent.

Read this before choosing "everyone": first messages to people who never wrote to you are what gets WhatsApp numbers restricted, WhatsApp's terms forbid automated sending from the Business app, and UK marketing rules treat basket reminders as marketing that needs consent. "Only people who ticked marketing" is the safe choice. The default is 5 a day, a few minutes apart.

## 9. On your phone

Open your site address in the phone browser, sign in, add it to the home screen, then **Connections, Phone notifications, Turn on**. On iPhone it must be added to the home screen first.

## 10. Lock settings with a PIN (if you want)

Every settings box has a lock button at its top right. Press it and pick a PIN of 4 to 8 numbers the first time. The box is then locked on every device, your phone and your laptop. Nobody can change it until it is unlocked with the PIN. You need the PIN to lock as well as to unlock. To change the PIN press any lock button, then **Change PIN**.

Locks never stop the agent working. These always work, even with everything locked: the agent switch, **Stop everything**, answering Urgent, sending and approving replies, the report link for Claude, and signing in and out. While **Knowledge** is locked an answer on Urgent still goes to the customer, but it is not saved to Knowledge.

After 5 wrong PINs the PIN does not work for 15 minutes on any device.

### Forgot your PIN

1. Sign in at dash.cloudflare.com.
2. Open **Storage & databases**, then **D1 SQL database**, then **acx-agent**.
3. Open **Console**, paste this line and press **Execute**:

```sql
DELETE FROM settings WHERE key IN ('state:lock_pin', 'state:locks', 'state:lock_fails');
```

4. Wait one minute and reload the dashboard. Everything is unlocked and there is no PIN. Press any lock button to pick a new one.

## Everyday

* **Urgent** is where it asks you. Type a rough answer, it writes it properly and the laptop sends it. Or press **Tell the agent what's going on**, say what is happening in your own words ("the 72v batteries are back on Friday") and press **Let the agent reply**. It writes the reply itself in the customer's style and never quotes your note. With **Remember this for next time** on, a note that helps with other customers is saved in Knowledge, where you can change or delete it. The note also stays with that chat.
* **Creator codes are made by the agent.** When a creator asks for their own code ("I would like to make my discount code MACCA5") the agent makes it in Shopify and sends "Your discount code MACCA5 is now live!!" in the same chat. You get a ping. Some requests come to you on Urgent instead, with an **Approve code** button: when the code is taken, the person already has a code, the daily limit is reached, the code has a rude word or is just the shop name, the agent is not sure, or Shopify is not connected. If they do not say which code they want, the agent asks them. Change this on **Discount codes** (under More): Auto, Ask me first or Off, the amount, the most codes a day and the message. Codes the agent made say **Made by agent**.
* **Discount codes** by hand: open the chat in Inbox and press **Make discount code**. Press **Done** and it makes the code in Shopify and sends it in the same chat. If Shopify is not connected or the app has no `write_discounts` scope, make the code in Shopify yourself, then press **Send message**.
* Gmail and TikTok start in "ask me first". Switch a channel to automatic in **Connections** when you trust it.
* If you reply to a customer yourself, the agent leaves that chat alone for 30 minutes.
* **Stop everything** on the Live screen switches it off and cancels anything waiting.
