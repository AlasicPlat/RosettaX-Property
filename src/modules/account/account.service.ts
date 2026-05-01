import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AppleAccount } from '../../entities/apple-account.entity';

/**
 * @description Apple 账号服务 — 封装 apple_account 表的数据访问逻辑.
 *
 * 提供基础 CRUD 与业务查询方法, 所有数据库操作通过 TypeORM Repository 完成,
 * 严禁在 Controller 层直接操作 Repository.
 */
@Injectable()
export class AccountService {
  private readonly logger = new Logger(AccountService.name);

  constructor(
    @InjectRepository(AppleAccount)
    private readonly accountRepo: Repository<AppleAccount>,
  ) { }

  /**
   * @description 根据邮箱查找账号 — 用于登录前检查是否已存在
   * @param email Apple ID 邮箱
   * @returns 匹配的账号实体, 不存在返回 null
   */
  async findByEmail(email: string): Promise<AppleAccount | null> {
    return this.accountRepo.findOne({ where: { email } });
  }

  /**
   * @description 根据 ID 查找账号
   * @param id 数据库主键 ID
   * @returns 匹配的账号实体, 不存在返回 null
   */
  async findById(id: number): Promise<AppleAccount | null> {
    return this.accountRepo.findOne({ where: { id } });
  }

  /**
   * @description 创建或更新账号 (Upsert 语义) — 以 email 为唯一键,
   * 存在则更新全部字段, 不存在则插入新记录.
   * @param data 账号数据 (部分字段可选)
   * @returns 保存后的完整账号实体
   */
  async upsert(data: Partial<AppleAccount>): Promise<AppleAccount> {
    // 优先通过 email 查找已有记录, 实现 upsert 语义
    if (data.email) {
      const existing = await this.findByEmail(data.email);
      if (existing) {
        Object.assign(existing, data);
        // this.logger.log(`账号已更新: ${data.email}`);
        return this.accountRepo.save(existing);
      }
    }
    const account = this.accountRepo.create(data);
    // this.logger.log(`新账号已录入: ${data.email}`);
    return this.accountRepo.save(account);
  }

  /**
   * @description 查询所有状态为 logged_in 的可用账号
   * @returns 可用账号列表
   */
  async findAllActive(): Promise<AppleAccount[]> {
    return this.accountRepo.find({ where: { status: 'logged_in' } });
  }

  /**
   * @description 更新账号状态 — 用于标记过期或重新激活
   * @param id 账号 ID
   * @param status 新状态值 (logged_in / expired)
   */
  async updateStatus(id: number, status: string): Promise<void> {
    await this.accountRepo.update(id, { status });
    this.logger.log(`账号 #${id} 状态已更新为: ${status}`);
  }

  /**
   * @description 按地区查询已登录的账号 — 用于兑换礼品卡时选择匹配地区的账号.
   *
   * @param region 目标地区代码 (如 'jp', 'cn')
   * @returns 该地区所有 logged_in 状态的账号列表
   */
  async findByRegion(region: string): Promise<AppleAccount[]> {
    return this.accountRepo.find({
      where: { region, status: 'logged_in' },
    });
  }
}
