// Keeps the last 300 log lines in memory AND prints them to the console
const MAX = 300;
const entries = [];

function log(step, data = {}, level = 'info') {
  entries.push({ t: new Date().toISOString(), level, step, ...data });
  if (entries.length > MAX) entries.shift();

  const line = `[PUSH] ${step} ${JSON.stringify(data)}`;
  if (level === 'error') console.error(line);
  else console.log(line);
}

module.exports = { log, entries };