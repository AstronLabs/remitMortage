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
| escrow | `attchg_a` | topics[] data(tuple)[threshold] v1 |
| escrow | `attchg_c` | topics[] data(tuple)[] v1 |
| escrow | `attchg_p` | topics[] data(tuple)[threshold, execute_after] v1 |
| escrow | `auto_cfg` | topics[goal_id] data(tuple)[borrower, amount, interval_ledgers] v1 |
| escrow | `auto_cxl` | topics[goal_id] data(value)[borrower] v1 |
| escrow | `auto_dep` | topics[goal_id] data(tuple)[borrower, amount, deposited] v1 |
| escrow | `ben_claim` | topics[goal_id] data(tuple)[borrower, beneficiary, total_amount] v1 |
| escrow | `ben_list` | topics[goal_id] data(tuple)[borrower, list.splits.len()] v1<br>topics[goal_id] data(tuple)[borrower, 0u32] v1 |
| escrow | `benefic` | topics[goal_id] data(tuple)[borrower, beneficiary] v1 |
| escrow | `deposit` | topics[goal_id] data(tuple)[borrower, amount + matched, deposited] v1 |
| escrow | `goal_xfer` | topics[from_goal_id, to_goal_id] data(tuple)[borrower, amount, preserved_start] v1 |
| escrow | `hs_appr` | topics[goal_id] data(tuple)[borrower, admin, reason_hash] v1 |
| escrow | `hs_pay` | topics[goal_id] data(tuple)[borrower, refund, approver, reason_hash] v1 |
| escrow | `hs_req` | topics[goal_id] data(tuple)[borrower, reason_hash] v1 |
| escrow | `pen_prop` | topics[] data(tuple)[tier1, tier2, tier3, tier4, execute_after] v1 |
| escrow | `pen_upd` | topics[] data(tuple)[tier1, tier2, tier3, tier4] v1 |
| escrow | `perm_mode` | topics[] data(value)[enabled] v1 |
| escrow | `rel_conf` | topics[goal_id] data(tuple)[borrower, release_time, reschedule_count] v1 |
| escrow | `rel_prop` | topics[goal_id] data(tuple)[borrower, release_time] v1 |
| escrow | `rollover` | topics[goal_id] data(tuple)[borrower, auto_rollover] v1<br>topics[goal_id] data(tuple)[borrower, amount_withdrawn] v1 |
| escrow | `top_up` | topics[goal_id] data(tuple)[borrower, amount, deposited] v1 |
| escrow | `ttl_ext` | topics[] data(value)[extended] v1 |
| escrow | `withdraw` | topics[goal_id] data(tuple)[borrower, refund, penalty] v1 |
| escrow | `wl_add` | topics[] data(tuple)[address] v1 |
| escrow | `wl_rm` | topics[] data(tuple)[address] v1 |
| governance | `delegate` | topics[delegator] data(value)[delegate] |
| governance | `revoke` | topics[delegator] data(value)[delegate] |
| insurance-pool | `batch_claim` | topics[] data(tuple)[claims.len(), total_requested, total_paid] |
| insurance-pool | `claim` | topics[] data(tuple)[recipient, amount]<br>topics[] data(tuple)[recipient, payout] |
| insurance-pool | `fund` | topics[] data(tuple)[from, amount] |
| insurance-pool | `premium_recorded` | topics[] data(tuple)[from, amount] |
| insurance-pool | `set_pool` | topics[] data(tuple)[lending_pool] |
| lending-pool | `accept_pd` | topics[] data(tuple)[pending] v1 |
| lending-pool | `adm_cncl` | topics[] data(tuple)[admin, pending] v1 |
| lending-pool | `adm_exp` | topics[] data(tuple)[new_admin, expires_at] v1 |
| lending-pool | `adm_win` | topics[] data(tuple)[window_secs] v1 |
| lending-pool | `app_fee_collected` | topics[] data(tuple)[borrower, loan_id, application_fee, loan_seq] v1 |
| lending-pool | `app_fee_refund` | topics[] data(tuple)[loan_id, borrower, fee, loan_seq] v1 |
| lending-pool | `app_fee_retained` | topics[] data(tuple)[loan_id, treasury_address, fee, loan_seq] v1 |
| lending-pool | `app_fee_set` | topics[] data(tuple)[previous_bps, new_bps] v1 |
| lending-pool | `assm_cfg` | topics[] data(value)[fee_bps] v1 |
| lending-pool | `assm_fee` | topics[] data(tuple)[loan_id, new_borrower, fee, loan_seq] v1 |
| lending-pool | `batch_skip` | topics[loan_id] data(value)["amt_inval"] v1<br>topics[loan_id] data(value)["not_found"] v1<br>topics[loan_id] data(value)["not_appr"] v1<br>topics[loan_id] data(value)["exc_prnc"] v1<br>topics[loan_id] data(value)["no_liq"] v1<br>topics[loan_id] data(value)["unauth_c"] v1<br>topics[loan_id] data(value)["lim_exc"] v1<br>topics[loan_id] data(value)["fee_high"] v1<br>topics[loan_id] data(value)["fee_amt"] v1 |
| lending-pool | `bonus_pay` | topics[investor] data(tuple)[payout, lockup.tier as u32] v1 |
| lending-pool | `cap_canc` | topics[Self::tranche_scope(&tranche)] data(tuple)[] v1 |
| lending-pool | `cap_canc/investor` | topics["investor"] data(tuple)[] v1 |
| lending-pool | `cap_prop` | topics[scope] data(tuple)[cap, execute_after] v1 |
| lending-pool | `cap_set` | topics[scope] data(tuple)[old, cap] v1 |
| lending-pool | `collateral_released` | topics[loan_id] data(tuple)[borrower, releasable, remaining_collateral, loan_seq] v1 |
| lending-pool | `collateral_topped_up` | topics[loan_id] data(tuple)[from, amount, remaining_collateral, ratio_bps, loan_seq] v1 |
| lending-pool | `credit_drawn` | topics[] data(tuple)[borrower, amount, drawn_balance] v1 |
| lending-pool | `credit_opened` | topics[] data(tuple)[borrower, approved_limit, interest_rate_bps] v1 |
| lending-pool | `credit_repaid` | topics[] data(tuple)[borrower, amount, drawn_balance] v1 |
| lending-pool | `debt_xfer` | topics[] data(tuple)[from, to, tranche, amount] v1 |
| lending-pool | `default` | topics[] data(tuple)[loan_id, borrower, seized_amount, net_loss, loan_seq] v1 |
| lending-pool | `default_recovered` | topics[] data(tuple)[loan_id, recovered_amount, loan_seq] v1 |
| lending-pool | `dep_fees` | topics[] data(tuple)[from, amount, total_interest] v1 |
| lending-pool | `dep_tier` | topics[investor] data(tuple)[amount, tier as u32, unlock_ledger, bonus_bps] v1 |
| lending-pool | `disburse` | topics[] data(tuple)[loan_id, recipient, amount, loan_seq] v1 |
| lending-pool | `early_fee_set` | topics[] data(tuple)[year1_bps, year2_bps, year3_plus_bps] v1 |
| lending-pool | `emrg_inj` | topics[] data(tuple)[proposal_id, insurance, amount] v1 |
| lending-pool | `escrow_rel_start` | topics[] data(tuple)[borrower, start_ledger] v1 |
| lending-pool | `ext_loan` | topics[loan_id] data(tuple)[borrower, additional_months, fee, duration_months, loan_seq] v1 |
| lending-pool | `fee_cap` | topics[] data(tuple)[max_abs, max_bps] v1 |
| lending-pool | `fee_capd` | topics[loan_id] data(tuple)[uncapped, capped, cap, loan_seq] v1 |
| lending-pool | `fee_ltc` | topics[] data(tuple)[cap_bps] v1 |
| lending-pool | `fee_ltcp` | topics[loan_id] data(tuple)[fee, room, ceiling, loan_seq] v1 |
| lending-pool | `fee_switch_set` | topics[] data(tuple)[previous_bps, new_bps] v1 |
| lending-pool | `fn_pause_set` | topics[group] data(tuple)[paused, admin] v1 |
| lending-pool | `grace_win_set` | topics[] data(tuple)[grace_ledgers, admin] v1 |
| lending-pool | `guardian_clr` | topics[] data(tuple)[old, admin] v1 |
| lending-pool | `guardian_pause` | topics[] data(tuple)[guardian, env.ledger().sequence()] v1 |
| lending-pool | `guardian_set` | topics[] data(tuple)[old, guardian, admin] v1 |
| lending-pool | `halving` | topics[] data(tuple)[epoch_fired, multiplier, new_last_halving - (epochs_elapsed - i - 1) * interval] v1 |
| lending-pool | `hcut_prop` | topics[asset_class] data(tuple)[haircut_bps, execute_after] v1 |
| lending-pool | `hcut_set` | topics[asset_class] data(tuple)[haircut_bps] v1 |
| lending-pool | `insurance_premium` | topics[] data(tuple)[loan_id, insurance_addr, premium, loan_seq] v1 |
| lending-pool | `keeper_reward_set` | topics[] data(tuple)[reward_bps, reward_cap] v1 |
| lending-pool | `keeper_rewarded` | topics[loan_id] data(tuple)[keeper, keeper_reward, loan_seq] v1 |
| lending-pool | `loan_approved` | topics[] data(tuple)[loan_id, loan_seq] v1 |
| lending-pool | `loan_cancelled` | topics[] data(tuple)[borrower, loan_id, loan_seq] v1 |
| lending-pool | `loan_closed` | topics[loan_id] data(tuple)[statement, loan_seq] v1 |
| lending-pool | `loan_defaulted` | topics[] data(tuple)[loan_id, net_loss, loan_seq] v1 |
| lending-pool | `loan_ported` | topics[] data(tuple)[loan_id, source_pool, loan_seq] v1 |
| lending-pool | `loan_refinanced` | topics[] data(tuple)[loan_id, locked_rate_bps, locked_duration_months, loan_seq] v1 |
| lending-pool | `loan_rejected` | topics[] data(tuple)[borrower, loan_id, loan_seq] v1 |
| lending-pool | `loan_requested` | topics[] data(tuple)[borrower, loan_id, principal, loan_seq] v1 |
| lending-pool | `maturity_rebate` | topics[] data(tuple)[borrower, loan_id, rebate_amount, loan_seq] v1 |
| lending-pool | `max_ltv_set` | topics[] data(tuple)[previous, max_ltv_bps] v1 |
| lending-pool | `migrate` | topics[] data(tuple)[ver] v1 |
| lending-pool | `note_hash_set` | topics[loan_id] data(tuple)[hash, loan_seq] v1<br>topics[loan_id] data(tuple)[note_hash, loan_seq] v1 |
| lending-pool | `oracle_set` | topics[] data(value)[oracle] v1 |
| lending-pool | `orig_fee_set` | topics[] data(tuple)[previous_bps, new_bps] v1 |
| lending-pool | `pay_quote` | topics[] data(tuple)[loan_id, quoted_amount, expires_ledger, loan_seq] v1 |
| lending-pool | `pay_quote/used` | topics["used"] data(tuple)[loan_id, amount, loan_seq] v1 |
| lending-pool | `perm_mode` | topics[] data(value)[enabled] v1 |
| lending-pool | `phase_tr` | topics[loan_id] data(tuple)[LoanPhase::Amortizing as u32, monthly_amount, loan_seq] v1 |
| lending-pool | `pool_paused` | topics[] data(tuple)[admin, env.ledger().sequence()] v1 |
| lending-pool | `pool_unpaused` | topics[] data(tuple)[admin, env.ledger().sequence()] v1 |
| lending-pool | `prepay_closed` | topics[] data(tuple)[loan_id, waived, prepayment_penalty, loan_seq] v1 |
| lending-pool | `prepay_penalty` | topics[] data(tuple)[loan_id, borrower, penalty, loan_seq] v1 |
| lending-pool | `prepay_waiver_set` | topics[] data(tuple)[previous, ledgers] v1 |
| lending-pool | `principal_paid` | topics[] data(tuple)[borrower, loan_id, amount, remaining_principal, outstanding_debt, loan_seq] v1 |
| lending-pool | `prop_adm` | topics[] data(tuple)[admin, new_admin] v1 |
| lending-pool | `protocol_fee` | topics[] data(tuple)[loan_id, treasury_address, protocol_fee, fee_switch_bps, loan_seq] v1 |
| lending-pool | `rate_adj` | topics[loan_id] data(tuple)[current_rate_bps, new_rate_bps, starting_rate_bps, loan_seq] v1 |
| lending-pool | `rate_cap` | topics[] data(tuple)[periodic_cap_bps, lifetime_cap_bps] v1 |
| lending-pool | `rate_crvp` | topics[] data(tuple)[curve, execute_after] v1 |
| lending-pool | `rate_crvs` | topics[] data(tuple)[curve] v1 |
| lending-pool | `refi_requested` | topics[] data(tuple)[loan_id, new_interest_rate_bps, new_duration_months, lock_expiry_ledger, loan_seq] v1 |
| lending-pool | `refinance_fee` | topics[loan_id] data(tuple)[fee, pool_fee, treasury_fee, loan_seq] v1 |
| lending-pool | `refund` | topics[] data(tuple)[loan_id, amount, loan_seq] v1 |
| lending-pool | `repay` | topics[] data(tuple)[borrower, loan_id, amount, 0i128, loan_seq] v1<br>topics[] data(tuple)[borrower, loan_id, amount, remaining - amount, loan_seq] v1 |
| lending-pool | `rpy_cap` | topics[] data(tuple)[cap] v1 |
| lending-pool | `rst_appr` | topics[] data(tuple)[loan_id, loan_seq] v1 |
| lending-pool | `rst_cncl` | topics[] data(tuple)[loan_id, loan_seq] v1 |
| lending-pool | `rst_prop` | topics[] data(tuple)[borrower, loan_id, loan_seq] v1 |
| lending-pool | `set_dpcl` | topics[] data(value)[cooldown] v1 |
| lending-pool | `set_drmnt` | topics[] data(value)[period] v1 |
| lending-pool | `set_eicap` | topics[] data(value)[cap_bps] v1 |
| lending-pool | `set_exposure_cap` | topics[] data(tuple)[max_amount, max_bps] v1 |
| lending-pool | `set_fwaiv` | topics[] data(value)[waiver_ledgers] v1 |
| lending-pool | `set_gov` | topics[] data(tuple)[governance] v1 |
| lending-pool | `set_grace` | topics[] data(value)[grace_ledgers] v1 |
| lending-pool | `set_ins` | topics[] data(tuple)[insurance_pool] v1 |
| lending-pool | `set_limit` | topics[] data(tuple)[limit] v1 |
| lending-pool | `set_max_loans` | topics[] data(tuple)[previous, max_loans] v1 |
| lending-pool | `set_maxsw` | topics[] data(value)[amount] v1 |
| lending-pool | `set_mindp` | topics[] data(value)[amount] v1 |
| lending-pool | `set_msig` | topics[] data(tuple)[validator] v1 |
| lending-pool | `set_penlt` | topics[] data(value)[daily_bps] v1 |
| lending-pool | `set_qwin` | topics[] data(value)[window_ledgers] v1 |
| lending-pool | `set_rcool` | topics[] data(value)[cooldown] v1 |
| lending-pool | `set_rllw` | topics[] data(value)[window] v1 |
| lending-pool | `set_vreg` | topics[] data(tuple)[registry] v1 |
| lending-pool | `shr_cap` | topics[] data(tuple)[max_bps] v1 |
| lending-pool | `term_cap` | topics[] data(tuple)[tier, max_months] v1 |
| lending-pool | `upg_prop` | topics[] data(tuple)[execute_after] v1 |
| lending-pool | `upgrade` | topics[] data(tuple)[new_wasm_hash, ver + 1] v1 |
| lending-pool | `util_auto_pause` | topics[] data(tuple)[util, threshold] v1 |
| lending-pool | `util_pause_clr` | topics[] data(tuple)[0u32, 0u32] v1<br>topics[] data(tuple)[util, threshold] v1 |
| lending-pool | `util_pause_lift` | topics[] data(tuple)[] v1 |
| lending-pool | `util_thresh_set` | topics[] data(value)[threshold_bps] v1 |
| lending-pool | `withdraw` | topics[] data(tuple)[investor, amount, fee_amount, net_amount, utilization_bps] v1 |
| lending-pool | `wl_add` | topics[] data(tuple)[contractor] v1<br>topics[] data(tuple)[address] v1 |
| lending-pool | `wl_expiry` | topics[] data(tuple)[address, at] v1 |
| lending-pool | `wl_renew` | topics[] data(tuple)[address, expires_at] v1 |
| lending-pool | `wl_rm` | topics[] data(tuple)[contractor] v1<br>topics[] data(tuple)[address] v1 |
| lending-pool | `wl_valid` | topics[] data(tuple)[validity_secs] v1 |
| lending-pool | `y_comp` | topics[investor] data(tuple)[amount, deposited] v1 |
| lending-pool | `y_mode` | topics[investor] data(value)[mode as u32] v1 |
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
