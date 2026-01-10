const express = require("express");
const path = require("path");

function createApp(options = {}) {
  const { serveStatic = false } = options;
  const app = express();

  if (serveStatic) {
    const publicDir = path.join(__dirname, "public");
    app.use(express.static(publicDir));
    app.get("/mixer", (req, res) => {
      res.sendFile(path.join(publicDir, "mixer.html"));
    });
  }

  return app;
}

if (require.main === module) {
  const app = createApp({ serveStatic: true });
  const PORT = process.env.PORT || 4444;
  app.listen(PORT, () => {
    console.log(`Server running at http://localhost:${PORT}/mixer`);
  });
}

module.exports = { createApp };
