import * as process from 'node:process';

export default () => ({
  port: parseInt(process.env.PORT || '3000', 10),
  host: process.env.HOST || 'localhost',
  database: {
    type: process.env.DB_TYPE || 'postgres',
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT || '5432', 10),
    username: process.env.DB_USERNAME || 'postgres',
    password: process.env.DB_PASSWORD || 'secret',
    name: process.env.DB_NAME || 'postgres',
    synchronize: false,  // schema managed via migration scripts in /scripts/
    autoLoadEntities: process.env.autoLoadEntities || true,
    logging: process.env.NODE_ENV !== 'production',
  },
  jwt: {
    secret: process.env.JWT_SECRET || 'secretKey',
    expiresIn: process.env.JWT_EXPIRES_IN || '60m',
  },

  appName: process.env.APP_NAME || 'Pishrun Project',
});
