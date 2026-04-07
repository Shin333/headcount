# Day 2b - new environment variables

Add these to `apps/orchestrator/.env` (keep your existing values too):

```
# Hourly cost cap (orchestrator pauses calls when this is reached for the current wall hour)
HOURLY_COST_CAP_USD=0.50

# Maximum chatter posts per agent per company day
CHATTER_POSTS_PER_AGENT_PER_DAY=3

# Reflection ritual frequency (wall-clock hours)
REFLECTION_WALL_INTERVAL_HOURS=1

# Whether the chatter ritual fires at all
CHATTER_ENABLED=true
```

## Speed multiplier reminder

Day 2b is calibrated for SPEED_MULTIPLIER=60 (about $2-3/wall day).
Higher speeds will hit the hourly cap more often. Lower speeds work fine.

To change speed, update both:
1. `SPEED_MULTIPLIER=60` in apps/orchestrator/.env
2. The `world_clock` row in Supabase: `update world_clock set speed_multiplier = 60 where id = 1;`
