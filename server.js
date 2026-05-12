"use strict";

const env = require("./src/config/env");
const app = require("./src/app");
const { caseSyncCronJob } = require("./src/modules/cron/case-sync-cron")
const { sendDueNotifications } = require("./src/modules/cron/case-sync-cron")
const cron = require('node-cron');

app.listen(env.PORT, () => {
  console.log(`Jurident eCourts API listening on port ${env.PORT}`);
});

//Schedule the job to run every minute (for testing)
cron.schedule('0 0 * * *', async () => {
  console.log('Starting case sync cron job at', new Date());
  try {
    await caseSyncCronJob();
    console.log('Case sync cron job completed at', new Date());
  } catch (err) {
    console.error('Error in case sync cron job:', err);
  }
}, {
  timezone: "Asia/Kolkata"
});

cron.schedule('0 8 * * *', async () => {
  console.log('Starting due notifications job at', new Date());
  try {
    await sendDueNotifications();
    console.log('Due notifications job completed at', new Date());
  } catch (err) {
    console.error('Error in due notifications job:', err);
  }
}, {
  timezone: "Asia/Kolkata"
});

module.exports = app;
