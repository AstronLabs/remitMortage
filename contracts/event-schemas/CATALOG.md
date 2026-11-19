# Event Catalog

Generated from `contracts/event-schemas/*.json` by
`node contracts/event-schemas/schema.cjs catalog`. **Do not edit by hand.**
Every event follows the naming convention in
`docs/EVENT_TOPIC_CONVENTION.md`.

| Contract | Event | Topics and payload (positional) |
|---|---|---|
| bridge-adapter | `cap_full` | topics[source_chain] data(tuple)[projected, cap] |
| bridge-adapter | `cap_prop` | topics[source_chain] data(tuple)[new_cap, execute_after] |
| bridge-adapter | `cap_rej` | topics[source_chain] data(tuple)[amount, volume, cap] |
| bridge-adapter | `cap_set` | topics[source_chain] data(value)[new_cap] |
| bridge-adapter | `cap_upd` | topics[source_chain] data(value)[new_cap] |
| bridge-adapter | `cap_warn` | topics[source_chain] data(tuple)[projected, cap] |
| escrow | `attchg_a` | topics[] data(tuple)[threshold] |
| escrow | `attchg_c` | topics[] data(tuple)[] |
| escrow | `attchg_p` | topics[] data(tuple)[threshold, execute_after] |
| escrow | `auto_cfg` | topics[goal_id] data(tuple)[borrower, amount, interval_ledgers] |
| escrow | `auto_cxl` | topics[goal_id] data(value)[borrower] |
| escrow | `auto_dep` | topics[goal_id] data(tuple)[borrower, amount, deposited] |
| escrow | `ben_claim` | topics[goal_id] data(tuple)[borrower, beneficiary, total_amount] |
| escrow | `ben_list` | topics[goal_id] data(tuple)[borrower, list.splits.len()]<br>topics[goal_id] data(tuple)[borrower, 0u32] |
| escrow | `benefic` | topics[goal_id] data(tuple)[borrower, beneficiary] |
| escrow | `deposit` | topics[goal_id] data(tuple)[borrower, amount + matched, deposited] |
| escrow | `goal_xfer` | topics[from_goal_id, to_goal_id] data(tuple)[borrower, amount, preserved_start] |
| escrow | `hs_appr` | topics[goal_id] data(tuple)[borrower, admin, reason_hash] |
| escrow | `hs_pay` | topics[goal_id] data(tuple)[borrower, refund, approver, reason_hash] |
| escrow | `hs_req` | topics[goal_id] data(tuple)[borrower, reason_hash] |
| escrow | `pen_prop` | topics[] data(tuple)[tier1, tier2, tier3, tier4, execute_after] |
| escrow | `pen_upd` | topics[] data(tuple)[tier1, tier2, tier3, tier4] |
| escrow | `perm_mode` | topics[] data(value)[enabled] |
| escrow | `rel_conf` | topics[goal_id] data(tuple)[borrower, release_time, reschedule_count] |
| escrow | `rel_prop` | topics[goal_id] data(tuple)[borrower, release_time] |
| escrow | `rollover` | topics[goal_id] data(tuple)[borrower, auto_rollover]<br>topics[goal_id] data(tuple)[borrower, amount_withdrawn] |
| escrow | `top_up` | topics[goal_id] data(tuple)[borrower, amount, deposited] |
| escrow | `ttl_ext` | topics[] data(value)[extended] |
| escrow | `withdraw` | topics[goal_id] data(tuple)[borrower, refund, penalty] |
| escrow | `wl_add` | topics[] data(tuple)[address] |
| escrow | `wl_rm` | topics[] data(tuple)[address] |
| governance | `delegate` | topics[delegator] data(value)[delegate] |
| governance | `revoke` | topics[delegator] data(value)[delegate] |
| insurance-pool | `batch_claim` | topics[] data(tuple)[claims.len(), total_requested, total_paid] |
| insurance-pool | `claim` | topics[] data(tuple)[recipient, amount]<br>topics[] data(tuple)[recipient, payout] |
| insurance-pool | `fund` | topics[] data(tuple)[from, amount] |
| insurance-pool | `premium_recorded` | topics[] data(tuple)[from, amount] |
| insurance-pool | `set_pool` | topics[] data(tuple)[lending_pool] |
| lending-pool | `accept_pd` | topics[] data(tuple)[pending] |
| lending-pool | `app_fee_collected` | topics[] data(tuple)[borrower, loan_id, application_fee] |
| lending-pool | `app_fee_refund` | topics[] data(tuple)[loan_id, borrower, fee] |
| lending-pool | `app_fee_retained` | topics[] data(tuple)[loan_id, treasury_address, fee] |
| lending-pool | `app_fee_set` | topics[] data(tuple)[previous_bps, new_bps] |
| lending-pool | `assm_cfg` | topics[] data(value)[fee_bps] |
| lending-pool | `assm_fee` | topics[] data(tuple)[loan_id, new_borrower, fee] |
| lending-pool | `batch_skip` | topics[loan_id] data(value)["amt_inval"]<br>topics[loan_id] data(value)["not_found"]<br>topics[loan_id] data(value)["not_appr"]<br>topics[loan_id] data(value)["exc_prnc"]<br>topics[loan_id] data(value)["no_liq"]<br>topics[loan_id] data(value)["unauth_c"]<br>topics[loan_id] data(value)["lim_exc"]<br>topics[loan_id] data(value)["fee_high"]<br>topics[loan_id] data(value)["fee_amt"] |
| lending-pool | `bonus_pay` | topics[investor] data(tuple)[payout, lockup.tier as u32] |
| lending-pool | `cap_canc` | topics[Self::tranche_scope(&tranche)] data(tuple)[] |
| lending-pool | `cap_canc/investor` | topics["investor"] data(tuple)[] |
| lending-pool | `cap_prop` | topics[scope] data(tuple)[cap, execute_after] |
| lending-pool | `cap_set` | topics[scope] data(tuple)[old, cap] |
| lending-pool | `collateral_released` | topics[loan_id] data(tuple)[borrower, releasable, remaining_collateral] |
| lending-pool | `collateral_topped_up` | topics[loan_id] data(tuple)[from, amount, remaining_collateral, ratio_bps] |
| lending-pool | `credit_drawn` | topics[] data(tuple)[borrower, amount, drawn_balance] |
| lending-pool | `credit_opened` | topics[] data(tuple)[borrower, approved_limit, interest_rate_bps] |
| lending-pool | `credit_repaid` | topics[] data(tuple)[borrower, amount, drawn_balance] |
| lending-pool | `debt_xfer` | topics[] data(tuple)[from, to, tranche, amount] |
| lending-pool | `default` | topics[] data(tuple)[loan_id, borrower, seized_amount, net_loss] |
| lending-pool | `default_recovered` | topics[] data(tuple)[loan_id, recovered_amount] |
| lending-pool | `dep_fees` | topics[] data(tuple)[from, amount, total_interest] |
| lending-pool | `dep_tier` | topics[investor] data(tuple)[amount, tier as u32, unlock_ledger, bonus_bps] |
| lending-pool | `disburse` | topics[] data(tuple)[loan_id, recipient, amount] |
| lending-pool | `emrg_inj` | topics[] data(tuple)[proposal_id, insurance, amount] |
| lending-pool | `escrow_rel_start` | topics[] data(tuple)[borrower, start_ledger] |
| lending-pool | `ext_loan` | topics[loan_id] data(tuple)[borrower, additional_months, fee, duration_months] |
| lending-pool | `fee_cap` | topics[] data(tuple)[max_abs, max_bps] |
| lending-pool | `fee_capd` | topics[loan_id] data(tuple)[uncapped, capped, cap] |
| lending-pool | `fee_switch_set` | topics[] data(tuple)[previous_bps, new_bps] |
| lending-pool | `fn_pause_set` | topics[group] data(tuple)[paused, admin] |
| lending-pool | `halving` | topics[] data(tuple)[epoch_fired, multiplier, new_last_halving - (epochs_elapsed - i - 1) * interval] |
| lending-pool | `hcut_prop` | topics[asset_class] data(tuple)[haircut_bps, execute_after] |
| lending-pool | `hcut_set` | topics[asset_class] data(tuple)[haircut_bps] |
| lending-pool | `insurance_premium` | topics[] data(tuple)[loan_id, insurance_addr, premium] |
| lending-pool | `keeper_reward_set` | topics[] data(tuple)[reward_bps, reward_cap] |
| lending-pool | `keeper_rewarded` | topics[loan_id] data(tuple)[keeper, keeper_reward] |
| lending-pool | `loan_approved` | topics[] data(tuple)[loan_id] |
| lending-pool | `loan_cancelled` | topics[] data(tuple)[borrower, loan_id] |
| lending-pool | `loan_defaulted` | topics[] data(tuple)[loan_id, net_loss] |
| lending-pool | `loan_ported` | topics[] data(tuple)[loan_id, source_pool] |
| lending-pool | `loan_refinanced` | topics[] data(tuple)[loan_id, locked_rate_bps, locked_duration_months] |
| lending-pool | `loan_rejected` | topics[] data(tuple)[borrower, loan_id] |
| lending-pool | `loan_requested` | topics[] data(tuple)[borrower, loan_id, principal] |
| lending-pool | `maturity_rebate` | topics[] data(tuple)[borrower, loan_id, rebate_amount] |
| lending-pool | `migrate` | topics[] data(tuple)[ver] |
| lending-pool | `orig_fee_set` | topics[] data(tuple)[previous_bps, new_bps] |
| lending-pool | `pay_quote` | topics[] data(tuple)[loan_id, quoted_amount, expires_ledger] |
| lending-pool | `pay_quote/used` | topics["used"] data(tuple)[loan_id, amount] |
| lending-pool | `perm_mode` | topics[] data(value)[enabled] |
| lending-pool | `phase_tr` | topics[loan_id] data(tuple)[LoanPhase::Amortizing as u32, monthly_amount] |
| lending-pool | `prepay_closed` | topics[] data(tuple)[loan_id, waived, prepayment_penalty] |
| lending-pool | `prepay_penalty` | topics[] data(tuple)[loan_id, borrower, penalty] |
| lending-pool | `prepay_waiver_set` | topics[] data(tuple)[previous, ledgers] |
| lending-pool | `prop_adm` | topics[] data(tuple)[admin, new_admin] |
| lending-pool | `protocol_fee` | topics[] data(tuple)[loan_id, treasury_address, protocol_fee, fee_switch_bps] |
| lending-pool | `refi_requested` | topics[] data(tuple)[loan_id, new_interest_rate_bps, new_duration_months, lock_expiry_ledger] |
| lending-pool | `refund` | topics[] data(tuple)[loan_id, amount] |
| lending-pool | `repay` | topics[] data(tuple)[borrower, loan_id, amount, 0i128]<br>topics[] data(tuple)[borrower, loan_id, amount, remaining - amount] |
| lending-pool | `rst_appr` | topics[] data(tuple)[loan_id] |
| lending-pool | `rst_cncl` | topics[] data(tuple)[loan_id] |
| lending-pool | `rst_prop` | topics[] data(tuple)[borrower, loan_id] |
| lending-pool | `set_dpcl` | topics[] data(value)[cooldown] |
| lending-pool | `set_eicap` | topics[] data(value)[cap_bps] |
| lending-pool | `set_exposure_cap` | topics[] data(tuple)[max_amount, max_bps] |
| lending-pool | `set_fwaiv` | topics[] data(value)[waiver_ledgers] |
| lending-pool | `set_gov` | topics[] data(tuple)[governance] |
| lending-pool | `set_grace` | topics[] data(value)[grace_ledgers] |
| lending-pool | `set_ins` | topics[] data(tuple)[insurance_pool] |
| lending-pool | `set_limit` | topics[] data(tuple)[limit] |
| lending-pool | `set_max_loans` | topics[] data(tuple)[previous, max_loans] |
| lending-pool | `set_maxsw` | topics[] data(value)[amount] |
| lending-pool | `set_mindp` | topics[] data(value)[amount] |
| lending-pool | `set_msig` | topics[] data(tuple)[validator] |
| lending-pool | `set_penlt` | topics[] data(value)[daily_bps] |
| lending-pool | `set_qwin` | topics[] data(value)[window_ledgers] |
| lending-pool | `set_rcool` | topics[] data(value)[cooldown] |
| lending-pool | `set_rllw` | topics[] data(value)[window] |
| lending-pool | `set_vreg` | topics[] data(tuple)[registry] |
| lending-pool | `upg_prop` | topics[] data(tuple)[execute_after] |
| lending-pool | `upgrade` | topics[] data(tuple)[new_wasm_hash, ver + 1] |
| lending-pool | `withdraw` | topics[] data(tuple)[investor, amount, fee_amount, net_amount, utilization_bps] |
| lending-pool | `wl_add` | topics[] data(tuple)[contractor]<br>topics[] data(tuple)[address] |
| lending-pool | `wl_rm` | topics[] data(tuple)[contractor]<br>topics[] data(tuple)[address] |
| lending-pool | `y_comp` | topics[investor] data(tuple)[amount, deposited] |
| lending-pool | `y_mode` | topics[investor] data(value)[mode as u32] |
| milestone | `dispute/raised` | topics["raised"] data(tuple)[proposal_id, caller, deadline_ledger] |
| milestone | `dispute/resolved` | topics["resolved"] data(tuple)[proposal_id, uphold] |
| milestone | `dispute/timeout` | topics["timeout"] data(tuple)[proposal_id, uphold_votes, reject_votes] |
| milestone | `milestone/full` | topics["full"] data(tuple)[proposal_id, remaining]<br>topics["full"] data(tuple)[proposal_id, release_amount] |
| milestone | `milestone/partial` | topics["partial"] data(tuple)[proposal_id, release_amount, remaining_after] |
| milestone | `ms_bonus` | topics[] data(tuple)[contractor, proposal_id, bonus_amount] |
| milestone | `ms_rej` | topics[] data(tuple)[governance_signer, proposal_id] |
| milestone | `ms_resub` | topics[] data(tuple)[contractor, proposal_id] |
| multisig-validator | `act_exec` | topics[proposal_id] data(tuple)[index, action_id, label] |
| multisig-validator | `mprop_exe` | topics[] data(tuple)[proposal_id, proposal.actions.len()] |
| multisig-validator | `mprop_sub` | topics[] data(tuple)[proposal_id, effective_expiry, actions.len()] |
| multisig-validator | `signers/add` | topics["add"] data(tuple)[signer, env.ledger().sequence(), env.ledger().timestamp()] |
| multisig-validator | `signers/config` | topics["config"] data(tuple)[signers.len(), now_ledger, now_ts] |
| multisig-validator | `signers/cooldown` | topics["cooldown"] data(tuple)[cooldown_ledgers, env.ledger().sequence()] |
| multisig-validator | `signers/remove` | topics["remove"] data(tuple)[signer, env.ledger().sequence(), env.ledger().timestamp()] |
| multisig-validator | `submitted` | topics[] data(tuple)[proposal_id, effective_expiry] |
| oracle-price | `price_sub` | topics[reporter] data(tuple)[price, updated_ledger] |
| oracle-price | `rep_add` | topics[] data(tuple)[reporter] |
| oracle-price | `rep_rm` | topics[] data(tuple)[reporter] |
| staking-pool | `claim_rew` | topics[] data(tuple)[staker, total_claim] |
| staking-pool | `rewards` | topics[] data(tuple)[total_reward, total_deposits] |
| staking-pool | `stake` | topics[] data(tuple)[staker, token, amount, minted] |
| staking-pool | `unstake` | topics[] data(tuple)[staker, shares, total_withdrawn] |
| verification-registry | `acc_adm` | topics[] data(tuple)[proposed] |
| verification-registry | `apl_res` | topics[] data(tuple)[reviewer, borrower, score_at_appeal, new_score] |
| verification-registry | `appeal` | topics[] data(tuple)[borrower, score, requested_ledger] |
| verification-registry | `decaycfg` | topics[] data(tuple)[threshold_ledgers, points_per_period, period_ledgers, min_score] |
| verification-registry | `init` | topics[] data(tuple)[admin] |
| verification-registry | `prop_adm` | topics[] data(tuple)[admin, new_admin] |
| verification-registry | `rate_cfg` | topics[] data(tuple)[admin, rate_excellent_bps, rate_good_bps, rate_fair_bps, rate_fallback_bps] |
| verification-registry | `risk_upd` | topics[] data(tuple)[borrower, old_score, score, was_on_time] |
| verification-registry | `set_lp` | topics[] data(tuple)[admin, lending_pool] |
| verification-registry | `set_rev` | topics[] data(tuple)[admin, reviewer] |
| verification-registry | `vreg` | topics[] data(tuple)[admin, borrower, score, verified_ledger, expiration_ledger] |
| yield-vault | `deposit` | topics[from] data(tuple)[amount, shares] |
| yield-vault | `harvest` | topics[] data(tuple)[harvested, assets_after, total_shares] |
| yield-vault | `liq_add` | topics[] data(tuple)[amount, new_liquidity] |
| yield-vault | `rec_cxl` | topics[investor] data(tuple)[] |
| yield-vault | `rec_done` | topics[investor] data(tuple)[recovery, shares] |
| yield-vault | `rec_reg` | topics[investor] data(value)[recovery] |
| yield-vault | `rec_req` | topics[investor] data(tuple)[recovery, execute_after_ledger] |
| yield-vault | `thresh` | topics[] data(tuple)[admin, threshold] |
| yield-vault | `w_fulfil` | topics[requester] data(tuple)[id, shares, amount] |
| yield-vault | `w_queued` | topics[to] data(tuple)[id, shares, amount] |
| yield-vault | `withdraw` | topics[to] data(tuple)[shares, amount] |
