import express, { type Express } from "express";
import cors from "cors";
import router from "./routes";

const app: Express = express();

// Public market history requires no credentials; wildcard CORS remains compatible
// with the hosted UI and does not enable credentialed cross-origin requests.
app.use(cors({ origin: "*" }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use("/api", router);


export default app;


