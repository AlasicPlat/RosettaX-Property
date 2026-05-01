import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
} from 'typeorm';

/**
 * @description Apple 账号实体 — 存储登录后的 Apple ID 全量信息.
 *
 * 对标 Java 版 DatabaseConfig.java 中 apple_account 表 DDL,
 * 包含认证令牌 (passwordToken / clearToken)、Store Front 路由信息、余额快照等.
 * 业务场景: 账号登录成功后持久化, 后续请求复用 session 凭证.
 *
 * 参考来源: @docs DatabaseConfig.java — createAppleAccount DDL
 */
@Entity('apple_account')
export class AppleAccount {
  @PrimaryGeneratedColumn({ type: 'int' })
  id: number;

  @Column({ name: 'group_id', type: 'int' })
  groupId: number;

  /** Apple ID 邮箱 — 唯一索引, 防止重复录入 */
  @Column({ type: 'varchar', length: 255, unique: true, comment: 'Apple ID 邮箱' })
  email: string;

  /** 账户持有人姓名 */
  @Column({ type: 'varchar', length: 255, default: '', comment: '账户持有人姓名' })
  name: string;


  @Column({ type: 'varchar', length: 255, comment: '密码' })
  password: string;

  /** 国家/地区 — cn/jp/sg/us等 */
  @Column({ type: 'varchar', length: 32, comment: '国家/地区 (cn/jp/sg/us等)' })
  region: string;

  /** DirectoryServicesId — Apple 内部用户标识 (dsPersonId) */
  @Column({ type: 'varchar', length: 64, default: '', comment: 'DirectoryServicesId (dsPersonId)' })
  dsid: string;

  /** X-Apple-Store-Front — 决定商店区域和语言 */
  @Column({ name: 'store_front', type: 'varchar', length: 64, default: '', comment: 'X-Apple-Store-Front' })
  storeFront: string;

  /** 后续请求路由标识 — 用于选择正确的 Apple 后端 pod */
  @Column({ type: 'varchar', length: 16, default: '', comment: '后续请求路由标识' })
  pod: string;

  /** 设备指纹 GUID (SHA1) — 模拟设备唯一标识 */
  @Column({ type: 'varchar', length: 64, default: '', comment: '设备指纹 GUID (SHA1)' })
  guid: string;

  /** MZFinance 认证令牌 — 用于商店购买/查询接口鉴权 */
  @Column({ name: 'password_token', type: 'text', nullable: true, comment: 'passwordToken (MZFinance 认证令牌)' })
  passwordToken: string | null;

  /** Session Token — 短效会话凭证, 需定期刷新 */
  @Column({ name: 'clear_token', type: 'text', nullable: true, comment: 'clearToken (session token)' })
  clearToken: string | null;

  /** 最后已知余额 (数值) — 定期同步更新 */
  @Column({ name: 'credit_balance', type: 'varchar', length: 64, default: '', comment: '最后已知余额 (数值)' })
  creditBalance: string;

  /** 最后已知余额 (格式化显示, 如 "$25.00") */
  @Column({ name: 'credit_display', type: 'varchar', length: 64, default: '', comment: '最后已知余额 (格式化显示)' })
  creditDisplay: string;

  /** 免费歌曲余额 */
  @Column({ name: 'free_song_balance', type: 'varchar', length: 64, default: '', comment: '免费歌曲余额' })
  freeSongBalance: string;

  /** 账号状态 — logged_in (可用) / expired (令牌过期需重登) */
  @Column({ type: 'varchar', length: 32, default: 'logged_in', comment: '账号状态 (logged_in/expired)' })
  status: string;

  /** 最后登录时间 */
  @Column({ name: 'last_login_at', type: 'datetime', default: () => 'CURRENT_TIMESTAMP', comment: '最后登录时间' })
  lastLoginAt: Date;

  @CreateDateColumn({ name: 'created_at', type: 'datetime' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'datetime' })
  updatedAt: Date;
}
