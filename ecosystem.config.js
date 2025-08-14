module.exports = {
  apps: [
    {
      name: 'baka-proxy',
      script: 'server.cjs',
      interpreter: 'node',
      env: {
        CHROME_PATH: '/usr/bin/chromium',
        SOCKS_PROXY: 'socks5://127.0.0.1:7890',
        NODE_ENV: 'production'
      },
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '500M',
      time: true
    }
  ]
};
