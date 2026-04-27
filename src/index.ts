import 'dotenv/config';
import cors from 'cors';
import express from 'express';
import { loadConfig } from './config.js';
import { rateLimit } from './middleware.js';
import { createTwapRouter } from './routes/twap.js';

const config = loadConfig();

const app = express();
app.use(cors());
app.use(express.json());
//app.use(rateLimit);

app.use('/twap', createTwapRouter(config));

app.get('/health', (_req, res) => {
    res.json({ status: 'ok' });
});

app.listen(config.port, () => {
    console.log(`Robin TWAP Oracle listening on port ${config.port}`);
    console.log(`  Oracle:  ${config.oracleAddress}`);
});
