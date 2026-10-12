# Caseload Manager

An offline-first, ADHD-friendly caseload, task and diary manager for Talking
Therapies work. There is **no server and no build step** — it is a plain static
site (HTML + CSS + vanilla JS), and all data stays in the browser on the device
(`localStorage` only; nothing is ever uploaded).

- `index.html` — app shell
- `app.js` — all logic (state, views, command palette, service-worker registration)
- `styles.css` — design system and layout
- `sw.js` — offline app-shell cache
- `manifest.webmanifest`, `icon-*` — installable PWA metadata and icons
- `.nojekyll` — tells GitHub Pages not to run Jekyll (so it serves files verbatim)

## Run locally

Because the app uses a service worker, serve it over HTTP rather than opening the
file directly:

```sh
python3 -m http.server 9876 --bind 127.0.0.1
# then open http://localhost:9876/
```

## Hosting on GitHub Pages

Everything is already set up for a **project page** at
`https://<username>.github.io/<repo>/`. All asset paths are relative, so they
resolve correctly under that sub-path, and the app uses hash routing
(`#/today`, `#/tasks`, …) so no server rewrites are needed.

1. Create a GitHub repository and push this folder to the `main` branch:

   ```sh
   git init
   git add -A
   git commit -m "Caseload Manager"
   git branch -M main
   git remote add origin https://github.com/<username>/<repo>.git
   git push -u origin main
   ```

2. In the repository, open **Settings → Pages**.
3. Under **Build and deployment → Source**, choose **Deploy from a branch**.
4. Set **Branch** to `main` and the folder to `/ (root)`, then **Save**.
5. Wait a minute for the first build; the site goes live at
   `https://<username>.github.io/<repo>/`.

That's it. GitHub Pages serves over HTTPS (required for the service worker) and
provides the correct `Content-Type` for `.webmanifest`, so the app is installable
straight away.

### Custom domain (optional)

Add a `CNAME` file at the repository root containing just your domain, and point
a DNS `CNAME` record at `<username>.github.io`. See GitHub's docs for details.

## Updating the deployed app

The service worker is **cache-first**, so after changing `app.js`, `styles.css`,
`index.html` or any asset, bump the version string in `sw.js`:

```js
const CACHE_VERSION = 'caseload-shell-v44'; // -> v45, v46, ...
```

Otherwise returning visitors keep the cached (old) files. After deploying, a
reload installs the new worker and the following load serves the new assets.

To test the update locally: open DevTools → Application → Service Workers →
**Unregister**, clear **Storage → Cache Storage**, then reload.

## Privacy

- No accounts, no backend, no analytics, no network calls except fetching the
  app's own static files.
- `robots.txt` and a `<meta name="robots" content="noindex">` tag keep the page
  out of search engines.
