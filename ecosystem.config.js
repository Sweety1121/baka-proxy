module.exports = {
  apps: [
    {
      name: 'baka',
      script: './server.cjs',
      instances: 1,
      autorestart: true,
      watch: false,
      env: {
        PORT: '8080',
        CHROME_PATH: '/usr/bin/chromium',
        PROXY: 'socks5://127.0.0.1:7890'
      }
    }
  ]
};
