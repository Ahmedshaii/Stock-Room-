import express, { type Express } from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import router from "./routes";
import { logger } from "./lib/logger";

const app: Express = express();

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);
// Public market history requires no credentials; wildcard CORS remains compatible
// with the hosted UI and does not enable credentialed cross-origin requests.
app.use(cors({ origin: "*" }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use("/api", router);


// World Solution AI Route
app.post("/api/solve", (req: any, res: any) => {
  const { problem } = req.body;

  if (!problem) {
    return res.status(400).json({
      error: "Please describe your problem"
    });
  }

  res.json({
    success: true,
    message: "World Solution AI received your problem!",
    problem: problem
  });
});

export default app;


