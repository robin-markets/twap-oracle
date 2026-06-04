import 'dotenv/config';
import cors from 'cors';
import express from 'express';
import { loadConfig } from './config.js';
import { rateLimit } from './middleware.js';
import { createTwapRouter } from './routes/twap.js';

const config = loadConfig();

const app = express();
app.set('trust proxy', config.trustProxy);
app.use(cors());
app.use(express.json());
if (config.rateLimitEnabled) {
    app.use(rateLimit);
}

app.use('/twap', createTwapRouter(config));

app.get('/health', (_req, res) => {
    res.json({ status: 'ok' });
});

for (const port of config.ports) {
    app.listen(port, () => {
        console.log(`Robin TWAP Oracle listening on port ${port}`);
    });
}
console.log(`  Oracle:      ${config.oracleAddress}`);
console.log(`  Trust proxy: ${String(config.trustProxy)}`);
console.log(`  Rate limit:  ${config.rateLimitEnabled ? 'enabled' : 'disabled'}`);
console.log(`  ROFL:        ${config.isRofl ? 'yes' : 'no'}`);
