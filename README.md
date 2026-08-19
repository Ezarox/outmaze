# Outmaze

Outmaze is a deterministic maze-building race. Build the maze that keeps your runner trapped longer than the opposing runner.

## Run locally

Install Node.js, then from this folder run:

```powershell
npm install
npm start
```

Open [http://localhost:8080](http://localhost:8080). Single-player, friend rooms, Party Mode, and the Daily Challenge use the same local server. Local profiles use separate test identities and do not contact Firebase. To test several identities alone, open URLs such as `http://localhost:8080/?devPlayer=fox` and `http://localhost:8080/?devPlayer=frog` in separate tabs.

Another device on the same network can join through the host computer's local network address, provided port 8080 is reachable through the host firewall. Both players must load Outmaze from the same running server.

## Public website

The game is published at [https://ezarox.github.io/outmaze/](https://ezarox.github.io/outmaze/) through GitHub Pages. HTML, CSS, the deterministic rules engine, and the single-player AI all run as static browser files without using the multiplayer server.

GitHub Pages deploys the `main` branch from the repository root. The `.nojekyll` marker keeps the files unchanged.

## Public multiplayer deployment

Friend rooms and Party Mode use the lightweight WebSocket server on Google Cloud Run. The browser connects only after a player opens an online mode. Cloud Run validates the GitHub Pages origin, holds temporary room state in memory, and redirects ordinary HTTP visitors back to the GitHub Pages site.

Firebase anonymously creates a secure identity that persists in the player's browser, so each player chooses an Outmaze name and emoji only once on that browser. Profiles and server-verified Daily best times are stored in Cloud Firestore; the Daily AI maze remains on the server and only its benchmark time is returned. The browser Firebase configuration in `firebase-config.js` contains public app identifiers, not billing credentials or server secrets.

After installing and signing into the Google Cloud CLI, deploy with:

```powershell
.\scripts\deploy-cloud-run.ps1 -ProjectId outmaze-ezarox
```

The deployment uses the Sydney region, a 60-minute WebSocket timeout, and one maximum server instance. Keeping one instance is deliberate while rooms are held in memory: it ensures every player reaches the same room registry. Profiles and Daily scores are already shared through Firestore, but increasing the instance limit still requires moving live room state to a shared service and adding connection recovery.

One-time Firebase setup is required for a new Google Cloud project:

1. Add Firebase to the existing project and accept the Firebase Terms in the Firebase console.
2. Register an Outmaze web app and copy its public configuration into `firebase-config.js`.
3. In Authentication, enable Anonymous as a provider. Leave automatic clean-up disabled so inactive browser profiles remain recoverable.
4. Create the default Firestore database in `australia-southeast1` and grant the Cloud Run service account `roles/datastore.user`.

The Outmaze project already uses a locked-down server architecture: browsers never access Firestore directly, and the Admin SDK validates each anonymous Firebase identity and submitted maze on Cloud Run.

The Google Cloud project must have an active billing account even when its usage remains within Cloud Run's free allowance. Configure a Cloud Run spend cap in Google Cloud before public promotion.

## Tests

```powershell
npm test
```

The suite covers the rules engine, deterministic AI, profiles, server-verified Daily scores, friend rooms, and multi-player Party Mode.
