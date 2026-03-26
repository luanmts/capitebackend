const express = require('express');
const cors = require('cors');
require('dotenv').config();
const supabase = require('./db/supabase');
const authRoutes = require('./routes/auth');

const app = express();

app.use(cors());
app.use(express.json());

app.use('/auth', authRoutes);

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
