// Current game localization: resources/zh/strings/key-value/key-value-strings-utf8.txt,
// Attack and Armor classes, string IDs 12400 + class ID. Reserved legacy
// classes use descriptive names cross-checked against DamageClass and this
// dataset's actual armour entries. See tools/TECH-TREE.md.
export const armorClassNames = Object.freeze({
  0:'奇观（保留）', 1:'步兵', 2:'主力舰', 3:'远程伤害', 4:'近战',
  5:'大象单位', 8:'骑兵', 11:'所有建筑', 13:'石料防御', 14:'捕食性动物',
  15:'步弓手', 16:'船舰', 17:'冲车、投石机与攻城塔', 18:'树木',
  19:'独特单位', 20:'攻城武器', 21:'标准建筑', 22:'城墙与城门',
  23:'火药单位', 24:'野猪', 25:'僧侣', 26:'城堡', 27:'长矛兵',
  28:'骑射手', 29:'冲击步兵', 30:'骆驼单位', 31:'旧利提斯穿甲（保留）',
  32:'意大利佣兵', 33:'火药副弹丸（保留）', 34:'捕鱼船', 35:'马穆鲁克',
  36:'英雄和国王', 37:'重型攻城武器', 38:'掷矛手', 39:'龙脉',
  40:'房屋与木栅栏（保留）', 41:'喷火船', 60:'远程战船'
});

export const armorClassNotes = Object.freeze({
  0:'游戏文本将其标为未使用的护甲；当前科技树数据中仍保留在奇观上。',
  31:'旧利提斯勇士无视护甲机制留下的字段，当前不代表额外生效的减伤。',
  33:'旧火药副弹丸相关字段，当前科技树数据未使用。',
  39:'埃塞俄比亚“龙脉”减免骑乘单位伤害所用的内部攻防字段；负值不是普通攻击力扣减。',
  40:'游戏文本将其标为未使用的护甲；当前数据中保留在房屋和木栅栏上。'
});
