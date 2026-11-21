import { Router, type IRouter } from "express";
import healthRouter from "./health";
import stocksRouter from "./stocks";
import solveRouter from "./solve";

const router: IRouter = Router();

router.use(healthRouter);
router.use(stocksRouter);
router.use(solveRouter);

export default router;
