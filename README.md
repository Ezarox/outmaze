# Outmaze

Outmaze is a deterministic maze-building race. Build the maze that keeps your runner trapped longer than the opposing runner.

## Run locally

Install Node.js, then from this folder run:

```powershell
npm install
npm start
```

Open [http://localhost:8080](http://localhost:8080). Single-player and two-player rooms use the same local server. To test multiplayer alone, open the page in two tabs, create a room in one, and join its five-character code in the other.

Another device on the same network can join through the host computer's local network address, provided port 8080 is reachable through the host firewall. Both players must load Outmaze from the same running server.

## Public multiplayer deployment

The public beta runs the existing website and WebSocket room server together on Google Cloud Run. The browser automatically connects back to the same host and protocol from which Outmaze was loaded, using secure WebSockets when the site uses HTTPS.

After installing and signing into the Google Cloud CLI, deploy with:

```powershell
.\scripts\deploy-cloud-run.ps1 -ProjectId outmaze-ezarox
```

The initial deployment uses the Sydney region, a 60-minute WebSocket timeout, and one maximum server instance. Keeping one instance is deliberate while rooms are held in memory: it ensures both players reach the same room registry. Before increasing this limit, move room state to a shared service such as Firebase Realtime Database or Redis and add connection recovery.

The Google Cloud project must have an active billing account even when its usage remains within Cloud Run's free allowance. Configure a budget alert in Google Cloud before public promotion.

## Tests

```powershell
npm test
```

The suite covers the rules engine, deterministic AI, and the two-player room protocol.
