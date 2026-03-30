const express = require('express');
const cors = require('cors');
require('dotenv').config();
const supabase = require('./db/supabase');
const authRoutes = require('./routes/auth');
const positionsRoutes = require('./routes/positions');
const { startRecurringMarketsCron } = require('./jobs/recurringMarketsCron');

const app = express();

app.use(cors());
app.use(express.json());

app.use('/auth', authRoutes);
app.use('/positions', positionsRoutes);
app.use('/settle', require('./routes/settlement'));
app.use('/markets', require('./routes/markets'));
app.use('/wallet', require('./routes/wallet'));
app.use('/prices', require('./routes/prices'));
app.use('/rodovia', require('./routes/rodovia'));
app.use('/internal/rodovia', require('./routes/rodovia'));

app.get('/health', async (req, res) => {
  const { data, error } = await supabase.from('markets').select('count');
  if (error) {
    return res.status(500).json({ status: 'erro', detail: error.message });
  }
  res.json({ status: 'ok', project: 'capite-api', db: 'conectado' });
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`Capite API rodando na porta ${PORT}`);
});
startRecurringMarketsCron();
