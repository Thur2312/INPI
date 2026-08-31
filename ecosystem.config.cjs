module.exports = {
  apps: [
    {
      name: 'inpi-dashboard',
      script: 'npm',
      args: 'run dashboard',
      cwd: '/opt/inpi',
      env: { NODE_ENV: 'production' },
      autorestart: true,
      restart_delay: 5000,
      max_restarts: 20,
      out_file: '/opt/inpi/output/logs/pm2-dashboard.out.log',
      error_file: '/opt/inpi/output/logs/pm2-dashboard.err.log',
    },
    {
      name: 'inpi-portal-cliente',
      script: 'npm',
      args: 'run portal-cliente',
      cwd: '/opt/inpi',
      env: { NODE_ENV: 'production' },
      autorestart: true,
      restart_delay: 5000,
      max_restarts: 20,
      out_file: '/opt/inpi/output/logs/pm2-portal.out.log',
      error_file: '/opt/inpi/output/logs/pm2-portal.err.log',
    },
  ],
};
