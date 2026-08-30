import { Router, type IRouter } from "express";
import healthRouter from "./health";
import discordRouter from "./discord";
import storageRouter from "./storage";

const router: IRouter = Router();

router.use(healthRouter);
router.use(discordRouter);
router.use(storageRouter);

export default router;
