# iPad Mirror

A small self-hosted screen-mirroring stack designed for this workflow:

**personal iPad -> Internet/WebRTC -> browser on a locked-down Windows PC**

The Windows computer only needs a modern browser. No receiver software is installed on Windows.

## Repository layout

- `web/` - static receiver UI for GitHub Pages.
- `web/test-sender.html` - desktop-only test sender so the WebRTC path can be proven before the native iPad app exists.
- `worker/` - Cloudflare Worker + Durable Object used only for signaling and short-lived ICE/TURN credentials.
- `.github/workflows/pages.yml` - publishes `web/` to GitHub Pages.

## Architecture

```text
                         signaling only
Browser receiver  <----------------------------> Cloudflare Worker
      |                                            + Durable Object
      |                                                   ^
      |                                                   |
      |                 WebRTC signaling                  |
      |                                                   |
      +================ WebRTC video ================== iPad
             direct peer-to-peer when possible
                     TURN when required
```

GitHub does not carry the video stream. The Cloudflare Worker normally carries only signaling messages. When TURN is configured and direct peer-to-peer traffic is blocked by a firewall/NAT, Cloudflare TURN may relay the WebRTC media.

# Phase 1 setup

## 1. Create the GitHub repository

Create a new GitHub repository and copy this entire project into it. Keep the `web`, `worker`, and `.github` directories at the repository root.

Push it to `main`.

Do **not** enable Pages yet; first deploy the signaling Worker so you know its URL.

## 2. Deploy the Cloudflare signaling Worker from your Mac

Prerequisites on the Mac:

- A Cloudflare account.
- Node.js/npm installed.

In Terminal:

```bash
cd worker
npm install
npx wrangler login
npx wrangler deploy
```

Wrangler prints a URL resembling:

```text
https://ipad-mirror-signal.<your-workers-subdomain>.workers.dev
```

Test it in a browser:

```text
https://ipad-mirror-signal.<your-workers-subdomain>.workers.dev/health
```

You should receive JSON containing `"ok":true`.

### About TURN

The project works without TURN for initial testing and returns Cloudflare STUN only.

For reliable operation through restrictive business networks, configure Cloudflare Realtime TURN. Create a TURN key in Cloudflare, then add the key ID and the API token used to generate temporary TURN credentials as Worker secrets:

```bash
cd worker
npx wrangler secret put TURN_KEY_ID
npx wrangler secret put TURN_KEY_API_TOKEN
npx wrangler deploy
```

The API token is kept only in the Worker. It is never placed in the GitHub Pages JavaScript. `/api/ice` generates short-lived WebRTC credentials for clients.

## 3. Point the web app at the Worker

Edit:

```text
web/config.js
```

Change:

```js
API_BASE: "https://YOUR-WORKER.workers.dev",
```

to your actual Worker URL.

Commit and push the change.

## 4. Enable GitHub Pages

In the GitHub repository:

1. Open **Settings**.
2. Open **Pages**.
3. Under **Build and deployment**, select **GitHub Actions** as the source.
4. Open the **Actions** tab and confirm `Deploy GitHub Pages` completes.

The workflow publishes only the `web/` directory.

Your site will look approximately like:

```text
https://YOURNAME.github.io/YOUR-REPOSITORY/
```

## 5. Restrict Worker CORS after the site works

During initial setup, `worker/wrangler.toml` contains:

```toml
ALLOWED_ORIGIN = "*"
```

After you know the GitHub Pages origin, replace `*` with the origin only, for example:

```toml
ALLOWED_ORIGIN = "https://YOURNAME.github.io"
```

Then redeploy:

```bash
cd worker
npx wrangler deploy
```

Note that the **origin** does not contain the repository path.

# Test before building the iPad app

The repository includes a desktop test sender. This lets you verify the networking and WebRTC stack independently of iPadOS.

### Computer A - receiver

Open:

```text
https://YOURNAME.github.io/YOUR-REPOSITORY/
```

The page creates a 10-character session code.

### Computer B - sender

Open:

```text
https://YOURNAME.github.io/YOUR-REPOSITORY/test-sender.html
```

Enter the receiver code and choose **Share this screen**.

For the best test, put the two computers on different networks, such as one computer on Wi-Fi and the other on a phone hotspot.

When connected, the receiver displays whether WebRTC selected:

- `Direct P2P` - media is traveling directly between the devices.
- `TURN relay` - the network required a relay.

If cross-network testing works here, the remaining work is replacing the desktop test sender with the native iPad sender.

# Security model in this starter

- Each session receives a random 10-character code from an alphabet that omits visually ambiguous characters.
- Only one `viewer` and one `sender` may be connected to a session at a time.
- The Worker relays WebRTC SDP/ICE signaling but does not record it.
- The web receiver does not record the media stream.
- TURN credentials, when enabled, are generated on the server and expire after four hours.
- The long-lived Cloudflare TURN API token stays in Worker secrets.

This is appropriate for a personal/internal prototype, but it is not yet a formally authenticated enterprise service. If the tool will carry sensitive company material, the next security phase should add authenticated session creation and an explicit access policy before broad deployment.

# Expected next phase: native iPad app

Once the browser receiver and signaling stack are tested, the iPad app needs to perform four jobs:

1. Capture the iPad display using Apple's supported screen-capture framework.
2. Encode/send the media through WebRTC.
3. Connect to the same Worker WebSocket endpoint as `role=sender`.
4. Accept the receiver's 10-character session code.

The JavaScript test sender is intentionally written to use the same signaling message types the Swift app will use:

- `offer`
- `answer`
- `ice`
- `ready`
- `peer-status`
- `peer-left`

That means the Worker and receiver should not need to be redesigned when the iPad sender is added.
