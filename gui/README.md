# AxleAgent UI

A minimal TypeScript web application that provides buttons to call all HTTP endpoints exposed by the AxleAgent server (server.py).

## Backend Endpoints Covered

The server runs at http://127.0.0.1:8080 by default.

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET    | /skills  | Retrieves the list of available skills. |
| GET    | /reload  | Reloads the agent (reloads skills/configuration). |
| GET    | /clear   | Clears the conversation history. |
| POST   | /talk    | Sends a text prompt to the agent (body: { "text": "..." }). |
| POST   | /cd      | Changes the agent's working directory (body: { "path": "..." }). |

## Project Files

- package.json — npm scripts and dependencies
- tsconfig.json — TypeScript compiler configuration
- index.html — UI layout with buttons and input fields
- styles.css — Styling for the page
- src/index.ts — TypeScript logic wiring the buttons to the endpoints
- README.md — This file

## How to Build

1. Install dependencies:

   npm install

2. Compile the TypeScript:

   npm run build

   The compiled JavaScript will be placed in dist/index.js.

## How to Run

1. Ensure the AxleAgent HTTP server is running:

   python server.py

   The server listens on http://127.0.0.1:8080.

2. Start the static file server:

   npm start

   This rebuilds the TypeScript and serves the static files (index.html, styles.css, dist/index.js) on a local port (usually http://localhost:3000).

3. Open the displayed URL in a browser and interact with the buttons.

Alternatively, after building you can serve the directory with any static server, e.g.:

   npx serve .

## Summary of Build/Run Steps

   # build
   npm install
   npm run build

   # run (with AxleAgent server already up)
   npm start

The UI includes five buttons:
- GET /skills
- GET /reload
- GET /clear
- POST /talk (with a text input)
- POST /cd (with a path input)

Each button calls its corresponding endpoint and displays the JSON response on the page.