import { Column, Entity, PrimaryGeneratedColumn } from "typeorm";

@Entity({ name: 'group_warm_up_record' })
export class GroupWarmUpRecord {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({
    type: 'int',
    name: 'group_id',
    default: () => '0',
    comment: '用户组id',
  })
  groupId!: number;

  @Column({
    type: 'varchar',
    length: 1024,
    name: 'regions',
    default: () => "''",
    comment: '预热地区',
  })
  regions!: string;

  @Column({
    type: 'datetime',
    name: 'created_at',
    default: () => 'CURRENT_TIMESTAMP(6)',
    comment: '创建时间',
  })
  createdAt!: Date;

  @Column({
    type: 'datetime',
    name: 'updated_at',
    default: () => 'CURRENT_TIMESTAMP(6)',
    comment: '更新时间',
  })
  updatedAt!: Date;
}