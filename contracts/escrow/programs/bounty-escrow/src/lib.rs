//! Non-custodial escrow for maintainer-funded Grainlify bounties.
//!
//! # What this program guarantees, and what it does not
//!
//! The money sits in a token account owned by a PDA of this program. Grainlify
//! never holds it and has no instruction that moves it to an address of
//! Grainlify's choosing: `release` pays the contributor recorded on the escrow
//! and the fee destination fixed at funding time, and nothing else.
//!
//! What the attestor CAN do, and the funder should understand before funding:
//! in draw mode Grainlify names the winner through `assign`, and `release`
//! then pays that address. A dishonest attestor could therefore assign an
//! address it controls. That is the direct cost of the funder pre-committing
//! to release without signing again - the trade made deliberately, because the
//! alternative is a contributor doing the work and being unable to get paid
//! when the funder goes quiet. Two things bound it: every assignment and
//! release is on-chain and attributable, and the funder can always `refund`
//! alone once the deadline passes, which is the path a stalled escrow takes by
//! default rather than by anyone's decision.
//!
//! `self_assign` mode removes even that: the funder names the contributor
//! themselves and the attestor cannot.

use anchor_lang::prelude::*;
use anchor_spl::token_interface::{
    self, CloseAccount, Mint, TokenAccount, TokenInterface, TransferChecked,
};

declare_id!("6MXnJKEdt1YPUZoxT8LkhL7bVshB68o4mXJiSfD8spDA");

/// Basis points of the funded amount taken as the platform fee.
///
/// Recorded on the escrow at funding time and shown to the funder before they
/// sign. It is never read from anywhere else at release: a fee that could be
/// changed after funding would not be a quoted fee.
pub const MAX_FEE_BPS: u16 = 1_000; // 10%, a ceiling the program will not exceed

/// How the contributor is chosen.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug)]
pub enum AssignmentMode {
    /// Grainlify runs the weighted draw and names the winner.
    Draw,
    /// The funder names the contributor themselves.
    SelfAssign,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug)]
pub enum EscrowState {
    /// Funded, nobody assigned yet. The funder may cancel.
    Funded,
    /// A contributor is named. The funder may no longer cancel; they may still
    /// refund once the deadline passes.
    Assigned,
    /// Paid out to the contributor.
    Released,
    /// Returned to the funder.
    Refunded,
}

#[account]
pub struct Escrow {
    /// Grainlify's bounty id, so an escrow can be matched to the bounty it
    /// funds without trusting an off-chain index.
    pub bounty_id: [u8; 16],
    pub funder: Pubkey,
    pub mint: Pubkey,
    /// The amount the contributor receives. The fee is charged on top, so the
    /// contributor is paid exactly what the bounty advertised.
    pub amount: u64,
    pub fee_bps: u16,
    /// The floor, in the mint's smallest unit. A percentage alone loses money
    /// at the small end: 2.5% of a $1 bounty is 2.5c against about 2.3c of
    /// cost, which is exactly the newcomer-sized bounty worth encouraging.
    pub fee_minimum: u64,
    pub fee_amount: u64,
    pub fee_destination: Pubkey,
    /// Who may attest that the work was merged. Fixed at funding.
    pub attestor: Pubkey,
    pub assignment_mode: AssignmentMode,
    pub state: EscrowState,
    /// Set by `assign`.
    pub contributor: Option<Pubkey>,
    /// True once anybody has ever been assigned, and never cleared.
    ///
    /// `cancel` asked only whether somebody was assigned right now, so a funder
    /// could assign, unassign and cancel straight back out - taking the whole
    /// escrow instantly while a contributor had merged-ready work in an open
    /// pull request and no deadline left to wait for. Once work has been handed
    /// to somebody, the way out is the deadline, which is the protection the
    /// contributor is relying on.
    pub ever_assigned: bool,
    /// Unix seconds. After this the funder may refund whatever the state.
    pub deadline: i64,
    /// The commit the attestor named at release. Recorded for the ledger; the
    /// funder could not have signed over it, because it does not exist when
    /// they fund.
    pub merge_commit: Option<[u8; 20]>,
    pub created_at: i64,
    pub bump: u8,
    pub vault_bump: u8,
}

impl Escrow {
    // discriminator + fields, with Option/enum tags
    pub const LEN: usize = 8 + 16 + 32 + 32 + 8 + 2 + 8 + 8 + 32 + 32 + 1 + 1 + (1 + 32) + 1 + 8 + (1 + 20) + 8 + 1 + 1;
}

#[error_code]
pub enum EscrowError {
    #[msg("the fee exceeds the ceiling this program will accept")]
    FeeTooHigh,
    #[msg("the amount must be greater than zero")]
    ZeroAmount,
    #[msg("the deadline must be in the future")]
    DeadlineInPast,
    #[msg("this escrow already has a contributor assigned")]
    AlreadyAssigned,
    #[msg("this escrow has no contributor assigned")]
    NotAssigned,
    #[msg("only the attestor may assign in draw mode")]
    AttestorOnly,
    #[msg("only the funder may assign in self-assign mode")]
    FunderOnly,
    #[msg("the deadline has not passed yet")]
    DeadlineNotReached,
    #[msg("this escrow is no longer open")]
    NotOpen,
    #[msg("the token account does not belong to the contributor on this escrow")]
    WrongContributor,
    #[msg("the fee account does not match the destination fixed at funding")]
    WrongFeeDestination,
    #[msg("cancelling is only possible before anybody has ever been assigned; after that the deadline applies")]
    AlreadyHasContributor,
}

/// Hand the vault's rent back and remove the account.
///
/// Both accounts this program creates are paid for by the funder, and at
/// 0.0032 SOL together that is real money to leave stranded once an escrow is
/// finished. The escrow account itself is returned by Anchor's `close`; the
/// vault is a token account, so it needs its own instruction.
fn close_vault<'info>(
    token_program: &Interface<'info, TokenInterface>,
    vault: &InterfaceAccount<'info, TokenAccount>,
    escrow: &Account<'info, Escrow>,
    destination: &AccountInfo<'info>,
    seeds: &[&[&[u8]]],
) -> Result<()> {
    token_interface::close_account(CpiContext::new_with_signer(
        token_program.to_account_info(),
        CloseAccount {
            account: vault.to_account_info(),
            destination: destination.clone(),
            authority: escrow.to_account_info(),
        },
        seeds,
    ))
}

#[program]
pub mod bounty_escrow {
    use super::*;

    /// Lock the funds.
    ///
    /// The funder signs this, and in signing it they are pre-committing to the
    /// release: after this, `release` needs only the attestor. The UI has to
    /// say so in words before this instruction is sent, because it is the one
    /// thing about this escrow a funder could be surprised by.
    pub fn initialize(
        ctx: Context<Initialize>,
        bounty_id: [u8; 16],
        amount: u64,
        fee_bps: u16,
        fee_minimum: u64,
        deadline: i64,
        assignment_mode: AssignmentMode,
    ) -> Result<()> {
        require!(amount > 0, EscrowError::ZeroAmount);
        require!(fee_bps <= MAX_FEE_BPS, EscrowError::FeeTooHigh);
        let now = Clock::get()?.unix_timestamp;
        require!(deadline > now, EscrowError::DeadlineInPast);

        // The fee is charged ON TOP of the amount, so the contributor receives
        // exactly the figure the bounty advertised. Rounding goes up, so the
        // fee is never silently short, and a floor applies underneath.
        let pct = ((amount as u128)
            .checked_mul(fee_bps as u128)
            .unwrap()
            .checked_add(9_999)
            .unwrap()
            / 10_000u128) as u64;
        let fee_amount = pct.max(fee_minimum);
        let total = amount.checked_add(fee_amount).unwrap();

        let e = &mut ctx.accounts.escrow;
        e.bounty_id = bounty_id;
        e.funder = ctx.accounts.funder.key();
        e.mint = ctx.accounts.mint.key();
        e.amount = amount;
        e.fee_bps = fee_bps;
        e.fee_minimum = fee_minimum;
        e.fee_amount = fee_amount;
        e.fee_destination = ctx.accounts.fee_destination.key();
        e.attestor = ctx.accounts.attestor.key();
        e.assignment_mode = assignment_mode;
        e.state = EscrowState::Funded;
        e.contributor = None;
        e.ever_assigned = false;
        e.deadline = deadline;
        e.merge_commit = None;
        e.created_at = now;
        e.bump = ctx.bumps.escrow;
        e.vault_bump = ctx.bumps.vault;

        token_interface::transfer_checked(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                TransferChecked {
                    from: ctx.accounts.funder_token.to_account_info(),
                    mint: ctx.accounts.mint.to_account_info(),
                    to: ctx.accounts.vault.to_account_info(),
                    authority: ctx.accounts.funder.to_account_info(),
                },
            ),
            total,
            ctx.accounts.mint.decimals,
        )?;

        emit!(EscrowFunded { escrow: e.key(), bounty_id, funder: e.funder, amount, fee_amount, deadline });
        Ok(())
    }

    /// Name the contributor.
    ///
    /// Who may call this depends on the mode the funder chose, and the program
    /// enforces that rather than trusting the caller to behave.
    pub fn assign(ctx: Context<Assign>, contributor: Pubkey) -> Result<()> {
        let e = &mut ctx.accounts.escrow;
        require!(e.state == EscrowState::Funded, EscrowError::NotOpen);
        require!(e.contributor.is_none(), EscrowError::AlreadyAssigned);

        match e.assignment_mode {
            AssignmentMode::Draw => {
                require_keys_eq!(ctx.accounts.signer.key(), e.attestor, EscrowError::AttestorOnly);
            }
            AssignmentMode::SelfAssign => {
                require_keys_eq!(ctx.accounts.signer.key(), e.funder, EscrowError::FunderOnly);
            }
        }

        e.contributor = Some(contributor);
        e.ever_assigned = true;
        e.state = EscrowState::Assigned;
        emit!(EscrowAssigned { escrow: e.key(), contributor });
        Ok(())
    }

    /// Pay the contributor, and the fee to the destination fixed at funding.
    ///
    /// Only the attestor signs. That is the pre-commitment the funder made in
    /// `initialize`, and it is what lets a contributor be paid for merged work
    /// when the funder has gone quiet.
    pub fn release(ctx: Context<Release>, merge_commit: [u8; 20]) -> Result<()> {
        let e = &ctx.accounts.escrow;
        require!(e.state == EscrowState::Assigned, EscrowError::NotAssigned);
        require_keys_eq!(ctx.accounts.attestor.key(), e.attestor, EscrowError::AttestorOnly);
        let contributor = e.contributor.ok_or(EscrowError::NotAssigned)?;
        require_keys_eq!(ctx.accounts.contributor_token.owner, contributor, EscrowError::WrongContributor);
        require_keys_eq!(ctx.accounts.fee_token.key(), e.fee_destination, EscrowError::WrongFeeDestination);

        let bounty_id = e.bounty_id;
        let bump = e.bump;
        let seeds: &[&[u8]] = &[b"escrow", bounty_id.as_ref(), &[bump]];
        let signer: &[&[&[u8]]] = &[seeds];
        let decimals = ctx.accounts.mint.decimals;
        let amount = e.amount;
        let fee_amount = e.fee_amount;

        token_interface::transfer_checked(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                TransferChecked {
                    from: ctx.accounts.vault.to_account_info(),
                    mint: ctx.accounts.mint.to_account_info(),
                    to: ctx.accounts.contributor_token.to_account_info(),
                    authority: ctx.accounts.escrow.to_account_info(),
                },
                signer,
            ),
            amount,
            decimals,
        )?;

        if fee_amount > 0 {
            token_interface::transfer_checked(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program.to_account_info(),
                    TransferChecked {
                        from: ctx.accounts.vault.to_account_info(),
                        mint: ctx.accounts.mint.to_account_info(),
                        to: ctx.accounts.fee_token.to_account_info(),
                        authority: ctx.accounts.escrow.to_account_info(),
                    },
                    signer,
                ),
                fee_amount,
                decimals,
            )?;
        }

        close_vault(
            &ctx.accounts.token_program,
            &ctx.accounts.vault,
            &ctx.accounts.escrow,
            &ctx.accounts.funder.to_account_info(),
            signer,
        )?;

        let e = &mut ctx.accounts.escrow;
        e.state = EscrowState::Released;
        e.merge_commit = Some(merge_commit);
        emit!(EscrowReleased { escrow: e.key(), contributor, amount, fee_amount, merge_commit });
        Ok(())
    }

    /// Return everything to the funder, once the deadline has passed.
    ///
    /// The funder alone. No attestation, no Grainlify involvement: this is the
    /// path that has to work when we are gone, and it is what makes the money
    /// theirs rather than ours.
    pub fn refund(ctx: Context<Refund>) -> Result<()> {
        let e = &ctx.accounts.escrow;
        require!(
            e.state == EscrowState::Funded || e.state == EscrowState::Assigned,
            EscrowError::NotOpen
        );
        require_keys_eq!(ctx.accounts.funder.key(), e.funder, EscrowError::FunderOnly);
        let now = Clock::get()?.unix_timestamp;
        require!(now >= e.deadline, EscrowError::DeadlineNotReached);

        let total = e.amount.checked_add(e.fee_amount).unwrap();
        let bounty_id = e.bounty_id;
        let bump = e.bump;
        let seeds: &[&[u8]] = &[b"escrow", bounty_id.as_ref(), &[bump]];
        let signer: &[&[&[u8]]] = &[seeds];

        token_interface::transfer_checked(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                TransferChecked {
                    from: ctx.accounts.vault.to_account_info(),
                    mint: ctx.accounts.mint.to_account_info(),
                    to: ctx.accounts.funder_token.to_account_info(),
                    authority: ctx.accounts.escrow.to_account_info(),
                },
                signer,
            ),
            total,
            ctx.accounts.mint.decimals,
        )?;

        close_vault(
            &ctx.accounts.token_program,
            &ctx.accounts.vault,
            &ctx.accounts.escrow,
            &ctx.accounts.funder.to_account_info(),
            signer,
        )?;

        let e = &mut ctx.accounts.escrow;
        e.state = EscrowState::Refunded;
        emit!(EscrowRefunded { escrow: e.key(), funder: e.funder, total });
        Ok(())
    }

    /// Take it back before anybody is assigned.
    ///
    /// Separate from `refund` because it is a different situation with a
    /// different rule: nobody has been told to start work, so there is no
    /// deadline to wait for.
    pub fn cancel(ctx: Context<Refund>) -> Result<()> {
        let e = &ctx.accounts.escrow;
        require!(e.state == EscrowState::Funded, EscrowError::NotOpen);
        // Not "is anybody assigned now" but "has anybody ever been": otherwise
        // unassign-then-cancel walks straight past the deadline.
        require!(!e.ever_assigned, EscrowError::AlreadyHasContributor);
        require_keys_eq!(ctx.accounts.funder.key(), e.funder, EscrowError::FunderOnly);

        let total = e.amount.checked_add(e.fee_amount).unwrap();
        let bounty_id = e.bounty_id;
        let bump = e.bump;
        let seeds: &[&[u8]] = &[b"escrow", bounty_id.as_ref(), &[bump]];
        let signer: &[&[&[u8]]] = &[seeds];

        token_interface::transfer_checked(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                TransferChecked {
                    from: ctx.accounts.vault.to_account_info(),
                    mint: ctx.accounts.mint.to_account_info(),
                    to: ctx.accounts.funder_token.to_account_info(),
                    authority: ctx.accounts.escrow.to_account_info(),
                },
                signer,
            ),
            total,
            ctx.accounts.mint.decimals,
        )?;

        close_vault(
            &ctx.accounts.token_program,
            &ctx.accounts.vault,
            &ctx.accounts.escrow,
            &ctx.accounts.funder.to_account_info(),
            signer,
        )?;

        let e = &mut ctx.accounts.escrow;
        e.state = EscrowState::Refunded;
        emit!(EscrowRefunded { escrow: e.key(), funder: e.funder, total });
        Ok(())
    }

    /// Put an assignment back, without paying and without closing the escrow.
    ///
    /// The stale sweeper calls this when a deadline to open a pull request
    /// lapses, and it is also the honest answer to "the maintainer rejected
    /// the pull request": the money stays where it is and the bounty can be
    /// drawn again.
    pub fn unassign(ctx: Context<Assign>) -> Result<()> {
        let e = &mut ctx.accounts.escrow;
        require!(e.state == EscrowState::Assigned, EscrowError::NotAssigned);
        match e.assignment_mode {
            AssignmentMode::Draw => {
                require_keys_eq!(ctx.accounts.signer.key(), e.attestor, EscrowError::AttestorOnly);
            }
            AssignmentMode::SelfAssign => {
                require_keys_eq!(ctx.accounts.signer.key(), e.funder, EscrowError::FunderOnly);
            }
        }
        let previous = e.contributor;
        e.contributor = None;
        e.state = EscrowState::Funded;
        emit!(EscrowUnassigned { escrow: e.key(), previous });
        Ok(())
    }
}

#[derive(Accounts)]
#[instruction(bounty_id: [u8; 16])]
pub struct Initialize<'info> {
    #[account(mut)]
    pub funder: Signer<'info>,
    #[account(
        init,
        payer = funder,
        space = Escrow::LEN,
        seeds = [b"escrow", bounty_id.as_ref()],
        bump
    )]
    pub escrow: Account<'info, Escrow>,
    #[account(
        init,
        payer = funder,
        seeds = [b"vault", escrow.key().as_ref()],
        bump,
        token::mint = mint,
        token::authority = escrow,
    )]
    pub vault: InterfaceAccount<'info, TokenAccount>,
    #[account(mut, token::mint = mint, token::authority = funder)]
    pub funder_token: InterfaceAccount<'info, TokenAccount>,
    pub mint: InterfaceAccount<'info, Mint>,
    /// CHECK: recorded, never signed by this program; the fee can only ever go here.
    pub fee_destination: UncheckedAccount<'info>,
    /// CHECK: recorded so only this key can attest later.
    pub attestor: UncheckedAccount<'info>,
    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct Assign<'info> {
    pub signer: Signer<'info>,
    #[account(mut, seeds = [b"escrow", escrow.bounty_id.as_ref()], bump = escrow.bump)]
    pub escrow: Account<'info, Escrow>,
}

#[derive(Accounts)]
pub struct Release<'info> {
    pub attestor: Signer<'info>,
    /// CHECK: the rent on both accounts was paid by the funder, so it goes back
    /// to the funder. Checked against the escrow, not trusted from the caller.
    #[account(mut, address = escrow.funder)]
    pub funder: UncheckedAccount<'info>,
    #[account(mut, close = funder, seeds = [b"escrow", escrow.bounty_id.as_ref()], bump = escrow.bump)]
    pub escrow: Account<'info, Escrow>,
    #[account(mut, seeds = [b"vault", escrow.key().as_ref()], bump = escrow.vault_bump)]
    pub vault: InterfaceAccount<'info, TokenAccount>,
    #[account(mut, token::mint = mint)]
    pub contributor_token: InterfaceAccount<'info, TokenAccount>,
    #[account(mut, token::mint = mint)]
    pub fee_token: InterfaceAccount<'info, TokenAccount>,
    pub mint: InterfaceAccount<'info, Mint>,
    pub token_program: Interface<'info, TokenInterface>,
}

#[derive(Accounts)]
pub struct Refund<'info> {
    #[account(mut, address = escrow.funder)]
    pub funder: Signer<'info>,
    #[account(mut, close = funder, seeds = [b"escrow", escrow.bounty_id.as_ref()], bump = escrow.bump)]
    pub escrow: Account<'info, Escrow>,
    #[account(mut, seeds = [b"vault", escrow.key().as_ref()], bump = escrow.vault_bump)]
    pub vault: InterfaceAccount<'info, TokenAccount>,
    #[account(mut, token::mint = mint, token::authority = funder)]
    pub funder_token: InterfaceAccount<'info, TokenAccount>,
    pub mint: InterfaceAccount<'info, Mint>,
    pub token_program: Interface<'info, TokenInterface>,
}

#[event]
pub struct EscrowFunded { pub escrow: Pubkey, pub bounty_id: [u8; 16], pub funder: Pubkey, pub amount: u64, pub fee_amount: u64, pub deadline: i64 }
#[event]
pub struct EscrowAssigned { pub escrow: Pubkey, pub contributor: Pubkey }
#[event]
pub struct EscrowUnassigned { pub escrow: Pubkey, pub previous: Option<Pubkey> }
#[event]
pub struct EscrowReleased { pub escrow: Pubkey, pub contributor: Pubkey, pub amount: u64, pub fee_amount: u64, pub merge_commit: [u8; 20] }
#[event]
pub struct EscrowRefunded { pub escrow: Pubkey, pub funder: Pubkey, pub total: u64 }
