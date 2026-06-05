// Конфиг драфта. Всё задаётся здесь (в проде — из админки).

export const DEFAULT_CONFIG = {
  managersCount: 5,        // база 5, поддержать 4–6
  budget: 100,             // млн на участника
  squadSize: 12,           // юнитов в составе (без замены)
  minIncrement: 1,         // шаг ставки (млн)
  teamLimit: 5,            // макс юнитов одного клуба на весь драфт (вкл. тренера и замену)
  positions: {
    GK:    { min: 1, max: 1 },
    DEF:   { min: 3, max: 5 },
    MID:   { min: 3, max: 5 },
    FWD:   { min: 1, max: 3 },
    COACH: { min: 1, max: 1 },
  },
};

export const POSITIONS = ['GK', 'DEF', 'MID', 'FWD', 'COACH'];
