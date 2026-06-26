const express = require('express');
const adminUsersRoutes = require('./routes/admin/users');
const { scheduleAnonymizationJob } = require('./jobs/scheduler');

const app = express();

app.use(express.json());

// Admin routes
app.use('/api/admin/users', adminUsersRoutes);

// Schedule background jobs
scheduleAnonymizationJob();

// ... rest of your app setup

module.exports = app;