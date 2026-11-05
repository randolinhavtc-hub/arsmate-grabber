# Arsmate Grabber

A Manifest V3 browser extension (Brave/Chrome) built as a technical study: it
reverse-engineers the media protection model of a subscription content
platform, documents every layer found, and downloads images at full resolution
for content the current account is authorized to reach.

Built for a job application. The deliverable is the analysis as much as the
tool.

## 1. Reconnaissance

The site ships a Nuxt SPA whose `window.NUXT.config` leaks the entire backend
surface with no obfuscation:

- `apiBaseUrl` — the REST API
- `mediaProxyUrl` — a Cloudflare Worker in front of a private R2 bucket
- `cloudflareR2PublicUrl` — the bucket directly, answering 401

The API answers unauthenticated on `/api/creators/{username}` and
`/api/posts/feed`. The feed returns `mediaItems[]` with `id`, `type`, `index`,
`requiresToken` and the original `fileName` — but `url: null` on every
protected item.

## 2. How the protection actually works

No file encryption. Three layers:

**CSS blur.** Locked cards render `thumbnail_blur.jpg` behind a CSS filter. The
real media never enters the DOM.

**Referer validation on the proxy.** Pasting a media URL into the address bar
returns `Direct URL access not allowed`. Copying the link is not enough.

**Per-object short-lived JWTs.** Authorized media is served as
`media-secure/{JWT}/{path}`. The payload carries `sub` (the exact object path),
`postId`, `userId` and a one-hour `exp`. Signed HS256 server-side, so the token
cannot be forged — only requested. Issuance goes through
`POST /api/image/generate-token` and `POST /api/video/generate-token` and is
gated on the account's access level.

Proxy route families observed: `media-secure` (token), `media-public` and
`legacy-cdn` (public, no token), `profile` (avatar/cover, open),
`video/{userId}/{mediaId}/thumbnail_blur.jpg` (preview, open).

## 3. Bypass

**Referer** — a `declarativeNetRequest` rule rewrites `Referer` and `Origin` to
the site origin on every proxy request. Without it, 403.

**CORS** — fetches run in the service worker under `host_permissions`, so the
blob is readable. Without it, the read is blocked.

**Enumeration** — `/api/posts/feed` is paginated to `hasMore: false`.

**Authorization** — `generate-token` is called per post with the session
`userId`, and the file is downloaded immediately because the token expires in
one hour.

**Preview fallback** — when the account cannot reach a post, the blur thumbnail
is saved with a `_blur` suffix and counted separately.

## 4. Measured results

Run with `contentFilter=free`: 9 images at full resolution (hundreds of KB up
to 1.2 MB each), zero failures.

Run with `contentFilter=all`: the same 9 at full resolution, the rest as blurred
previews or unavailable, with the API returning `restricted: true` and
`"Tu suscripción ha expirado"`.

## 5. Honest limits

**Subscription content requires a subscription.** The gate is evaluated before
the object is looked up: with `hasAccess: false` the server never touches the
file. Five alternative proxy routes and four alternative endpoints were tested
(`mediaId`, `type`, `token_id`, `/api/media/generate-token`, `/api/posts/generate-token`,
`/api/image/token`, `/api/media/token`) — all return the same gate. The JWT is
server-signed, so there is nothing to forge.

`mediaId` is ignored by `generate-token`: one image per post. Multi-image posts
only resolve through the feed `url`, which exists for public content only.

Legacy posts use a flattened path (`legacy-cdn`) and can issue a valid token for
a missing object (403 on GET).

Video is HLS: master manifest, variant playlist, `.ts` segments. One token
covers the prefix, but the assembled Blob lives in RAM until saved.

## 6. Running it

1. `brave://extensions` → enable Developer mode → Load unpacked → select this
   folder.
2. Open a creator profile and scroll once so cards mount.
3. Open the extension popup. Use the Free filter for the public corpus, All to
   map the boundary.

The popup detects the session `userId` from the feed request the page already
made; it can also be typed in manually.

## 7. Architecture

- `manifest.json` — MV3 manifest, `host_permissions`, DNR rule registration
- `rules.json` — Referer/Origin rewrite rule
- `background.js` — service worker: enumeration, token issuance, download,
  classification counters
- `popup.html` / `popup.js` — control surface and live log

## 8. Notes

`generate-token` returns `imageUrl` on success and `restricted: true` when the
account lacks access. Success is followed by an immediate GET, since the token
lives one hour. Downloads are written as data URLs through
`chrome.downloads`, which sidesteps the referer check on the final fetch.

Content belongs to the creators. Built for personal study.
