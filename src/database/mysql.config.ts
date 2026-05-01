import { ConfigService } from '@nestjs/config';
import { TypeOrmModuleOptions } from '@nestjs/typeorm';
import { AppleAccount } from '../entities/apple-account.entity';

/**
 * @description 从环境变量读取数字配置, 避免 ConfigService 泛型误导导致字符串被直接透传.
 * @param configService Nest 配置服务.
 * @param key 环境变量名称.
 * @param fallback 配置缺失或不是有效数字时使用的默认值.
 * @returns 已解析的数字配置.
 */
export function getNumberConfig(configService: ConfigService, key: string, fallback: number): number {
  const rawValue = configService.get<string | number>(key);
  const parsedValue = Number(rawValue);

  return Number.isFinite(parsedValue) ? parsedValue : fallback;
}

/**
 * @description 构建 RosettaX-Property MySQL 连接配置.
 *
 * 设计意图:
 *   多 Pod 与 Admin server 共用同一个 MySQL 实例时, 连接池必须主动回收空闲连接,
 *   并启用 TCP keepalive, 避免复用被 NAT、防火墙或 MySQL 服务端回收的 socket.
 *
 * @param configService Nest 配置服务.
 * @returns TypeORM MySQL 连接配置.
 */
export function createMysqlOptions(configService: ConfigService): TypeOrmModuleOptions {
  const connectionLimit = getNumberConfig(configService, 'MYSQL_CONNECTION_LIMIT', 10);

  return {
    type: 'mysql',
    host: configService.get<string>('MYSQL_HOST', '127.0.0.1'),
    port: getNumberConfig(configService, 'MYSQL_PORT', 3306),
    username: configService.get<string>('MYSQL_USER', 'app'),
    password: configService.get<string>('MYSQL_PASSWORD', 'app123'),
    database: configService.get<string>('MYSQL_DATABASE', 'oppotunity'),
    entities: [AppleAccount],
    synchronize: false,
    charset: 'utf8mb4',
    timezone: '+08:00',
    connectTimeout: getNumberConfig(configService, 'MYSQL_CONNECT_TIMEOUT_MS', 10000),
    acquireTimeout: getNumberConfig(configService, 'MYSQL_ACQUIRE_TIMEOUT_MS', 10000),
    retryAttempts: getNumberConfig(configService, 'MYSQL_RETRY_ATTEMPTS', 10),
    retryDelay: getNumberConfig(configService, 'MYSQL_RETRY_DELAY_MS', 3000),
    logging: ['query', 'error'],
    extra: {
      waitForConnections: true,
      connectionLimit,
      maxIdle: getNumberConfig(configService, 'MYSQL_MAX_IDLE', Math.min(connectionLimit, 5)),
      idleTimeout: getNumberConfig(configService, 'MYSQL_IDLE_TIMEOUT_MS', 30000),
      enableKeepAlive: true,
      keepAliveInitialDelay: getNumberConfig(configService, 'MYSQL_KEEPALIVE_INITIAL_DELAY_MS', 0),
    },
  };
}
