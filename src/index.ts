import path from "path";
import express from "express";
import { config, ROOT_DIR } from "./config";
import "./db";

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "200kb" }));
app.use(express.static(path.join(ROOT_DIR, "public")));

app.listen(config.port, config.host, () => {
  console.log(`Mom English running at http://${config.host}:${config.port}`);
});
