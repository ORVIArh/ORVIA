//! Experimental integer-only binary128 molecular pair backend.
//! This has a new nearest-even arithmetic policy; it is not an ABDK drop-in.
//! No host floating-point operations are used in the computation.
#![cfg_attr(target_arch = "wasm32", no_main)]

extern crate alloc;

use ruint::aliases::U256;
use rustc_apfloat::{ieee::Quad, Float, Round};

const SIGN: u128 = 1 << 127;
const FRACTION: u128 = (1 << 112) - 1;
const EXPONENT: u128 = 0x7fff << 112;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Error { NonFinite, DivisionByZero, NegativeSquareRoot, InvalidParameter, ZeroSeparation }

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Q(pub u128);
impl Q {
    pub const ZERO: Self = Self(0);
    pub const ONE: Self = Self(0x3fff0000000000000000000000000000);
    pub fn new(bits: u128) -> Result<Self, Error> {
        if bits & EXPONENT == EXPONENT { return Err(Error::NonFinite); }
        Ok(Self(if bits & !SIGN == 0 { 0 } else { bits }))
    }
    fn checked(value: Quad) -> Result<Self, Error> { Self::new(value.to_bits()) }
    pub fn int(value: i128) -> Self { Self(Quad::from_i128(value).value.to_bits()) }
    pub fn add(self, b: Self) -> Result<Self, Error> { Self::checked(Quad::from_bits(self.0).add_r(Quad::from_bits(b.0), Round::NearestTiesToEven).value) }
    pub fn sub(self, b: Self) -> Result<Self, Error> { self.add(b.neg()) }
    pub fn mul(self, b: Self) -> Result<Self, Error> { Self::checked(Quad::from_bits(self.0).mul_r(Quad::from_bits(b.0), Round::NearestTiesToEven).value) }
    pub fn div(self, b: Self) -> Result<Self, Error> {
        if b.0 & !SIGN == 0 { return Err(Error::DivisionByZero); }
        Self::checked(Quad::from_bits(self.0).div_r(Quad::from_bits(b.0), Round::NearestTiesToEven).value)
    }
    pub fn neg(self) -> Self { if self.0 & !SIGN == 0 { Self::ZERO } else { Self(self.0 ^ SIGN) } }
    pub fn positive(self) -> bool { self.0 != 0 && self.0 & SIGN == 0 }
    pub fn negative(self) -> bool { self.0 & SIGN != 0 && self.0 & !SIGN != 0 }
    pub fn ge(self, b: Self) -> bool { Quad::from_bits(self.0) >= Quad::from_bits(b.0) }
    pub fn gt(self, b: Self) -> bool { Quad::from_bits(self.0) > Quad::from_bits(b.0) }
    /// Exact integer square root followed by nearest-even binary128 rounding.
    /// A positive binary128 input's square root is normal, including subnormals.
    pub fn sqrt(self) -> Result<Self, Error> {
        Self::new(self.0)?;
        if self.0 & !SIGN == 0 { return Ok(Self::ZERO); }
        if self.negative() { return Err(Error::NegativeSquareRoot); }
        let field = ((self.0 >> 112) & 0x7fff) as i32;
        let mut significand = self.0 & FRACTION;
        let mut exponent;
        if field == 0 {
            let shift = significand.leading_zeros() as i32 - 15;
            significand <<= shift as usize;
            exponent = -16382 - shift;
        } else { significand |= 1 << 112; exponent = field - 16383; }
        if exponent & 1 != 0 { significand <<= 1; exponent -= 1; }
        let radicand: U256 = U256::from(significand) << 112usize;
        let mut root: U256 = U256::from(1u8) << ((radicand.bit_len() + 1) / 2);
        // Newton iteration monotonically descends from a strict upper bound.
        // 226-bit input: at most 9 steps suffice; 16 is a fixed fail-closed cap.
        let mut converged = false;
        for _ in 0..16 {
            let next: U256 = (root + radicand / root) >> 1usize;
            if next >= root { converged = true; break; }
            root = next;
        }
        if !converged { return Err(Error::InvalidParameter); }
        let remainder = radicand - root * root;
        // For integer N, N == (root+1/2)^2 is impossible: its fraction is 1/4.
        // Hence no exact halfway tie exists for this normalized integer root.
        if remainder > root { root += U256::from(1u8); }
        let mut mantissa = root.to::<u128>();
        let mut result_exponent = exponent / 2;
        if mantissa == 1 << 113 { mantissa >>= 1; result_exponent += 1; }
        Self::new((((result_exponent + 16383) as u128) << 112) | (mantissa & FRACTION))
    }
}

#[derive(Clone, Copy, Debug)]
pub struct Pair {
    pub displacement: [u128; 3], pub sigma: u128, pub epsilon: u128,
    pub charge_product: u128, pub prefactor: u128,
    pub switch_distance: u128, pub cutoff: u128, pub exception: bool,
}

pub fn evaluate(p: Pair) -> Result<(u128, [u128; 3]), Error> {
    let sigma = Q::new(p.sigma)?; let epsilon = Q::new(p.epsilon)?;
    let charge = Q::new(p.charge_product)?; let prefactor = Q::new(p.prefactor)?;
    let rs = Q::new(p.switch_distance)?; let rc = Q::new(p.cutoff)?;
    if !sigma.positive() || epsilon.negative() || prefactor.negative() || !rs.positive() || !rc.gt(rs) { return Err(Error::InvalidParameter); }
    let d = [Q::new(p.displacement[0])?,Q::new(p.displacement[1])?,Q::new(p.displacement[2])?];
    let mut r2 = Q::ZERO;
    for x in d { r2 = r2.add(x.mul(x)?)?; }
    if r2 == Q::ZERO { return Err(Error::ZeroSeparation); }
    let r = r2.sqrt()?;
    if !p.exception && r.ge(rc) { return Ok((0,[0;3])); }
    let mut energy = Q::ZERO; let mut force = [Q::ZERO;3];
    if epsilon != Q::ZERO {
        let s2 = sigma.mul(sigma)?.div(r2)?;
        let s6 = s2.mul(s2)?.mul(s2)?;
        let s12 = s6.mul(s6)?;
        energy = Q::int(4).mul(epsilon)?.mul(s12.sub(s6)?)?;
        let scale = Q::int(24).mul(epsilon)?.mul(s6.sub(Q::int(2).mul(s12)?)?)?.div(r2)?;
        for i in 0..3 { force[i] = scale.mul(d[i])?; }
    }
    let strength = charge.mul(prefactor)?;
    if p.exception {
        let ec = strength.div(r)?;
        energy = energy.add(ec)?;
        let scale = ec.div(r2)?.neg();
        for i in 0..3 { force[i] = force[i].add(scale.mul(d[i])?)?; }
    } else {
        if r.gt(rs) {
            let width = rc.sub(rs)?;
            let x = r.sub(rs)?.div(width)?;
            let t = rc.sub(r)?.div(width)?;
            let t2 = t.mul(t)?;
            let switch = t2.mul(t)?.mul(Q::int(10).sub(Q::int(15).mul(t)?)?.add(Q::int(6).mul(t2)?)?)?;
            let derivative = Q::int(30).mul(x.mul(x)?.mul(t2)?)?.div(width)?.neg();
            let correction = energy.mul(derivative)?.div(r)?;
            for i in 0..3 { force[i] = switch.mul(force[i])?.add(correction.mul(d[i])?)?; }
            energy = switch.mul(energy)?;
        }
        if strength != Q::ZERO {
            let t = r.div(rc)?;
            let gap = rc.sub(r)?.div(rc)?;
            let er = strength.mul(gap.mul(gap)?.mul(t.add(Q::int(2))?)?.div(r)?.div(Q::int(2))?)?;
            let scale = strength.mul(gap.mul(Q::ONE.add(t.add(t.mul(t)?)?)?)?.div(r)?.div(r)?.div(r)?)?.neg();
            energy = energy.add(er)?;
            for i in 0..3 { force[i] = force[i].add(scale.mul(d[i])?)?; }
        }
    }
    Ok((energy.0,[force[0].0,force[1].0,force[2].0]))
}

#[cfg(target_arch = "wasm32")]
mod contract {
    use super::*;
    use stylus_sdk::{alloy_primitives::{FixedBytes,B256},prelude::*};
    sol_storage! { #[entrypoint] pub struct QuadKernel {} }
    #[public]
    impl QuadKernel {
        pub fn implementation_id(&self) -> B256 { FixedBytes::new(*b"ORVIA.WASMQUAD.NEAREST.V1.......") }
        pub fn add(&self, a:FixedBytes<16>, b:FixedBytes<16>) -> Result<FixedBytes<16>,Vec<u8>> {
            let output = Q::new(u128::from_be_bytes(a.0)).and_then(|x|Q::new(u128::from_be_bytes(b.0)).and_then(|y|x.add(y))).map_err(error)?;
            Ok(FixedBytes::new(output.0.to_be_bytes()))
        }
        pub fn sqrt(&self, a:FixedBytes<16>) -> Result<FixedBytes<16>,Vec<u8>> {
            let output = Q::new(u128::from_be_bytes(a.0)).and_then(Q::sqrt).map_err(error)?;
            Ok(FixedBytes::new(output.0.to_be_bytes()))
        }
        pub fn evaluate(&self,d:[FixedBytes<16>;3],sigma:FixedBytes<16>,epsilon:FixedBytes<16>,charge:FixedBytes<16>,prefactor:FixedBytes<16>,rs:FixedBytes<16>,rc:FixedBytes<16>,exception:bool) -> Result<(FixedBytes<16>,[FixedBytes<16>;3]),Vec<u8>> {
            let (e,f) = evaluate(Pair{displacement:d.map(|v|u128::from_be_bytes(v.0)),sigma:u128::from_be_bytes(sigma.0),epsilon:u128::from_be_bytes(epsilon.0),charge_product:u128::from_be_bytes(charge.0),prefactor:u128::from_be_bytes(prefactor.0),switch_distance:u128::from_be_bytes(rs.0),cutoff:u128::from_be_bytes(rc.0),exception}).map_err(error)?;
            Ok((FixedBytes::new(e.to_be_bytes()),f.map(|v|FixedBytes::new(v.to_be_bytes()))))
        }
    }
    fn error(e:Error)->Vec<u8>{vec![e as u8]}
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test] fn exact_values_and_finite_domains() {
        assert_eq!(Q::int(1).add(Q::int(2)),Ok(Q::int(3)));
        assert_eq!(Q::int(4).sqrt(),Ok(Q::int(2)));
        assert_eq!(Q::new(SIGN),Ok(Q::ZERO));
        assert_eq!(Q::new(EXPONENT),Err(Error::NonFinite));
        assert_eq!(Q::int(-1).sqrt(),Err(Error::NegativeSquareRoot));
        assert_eq!(Q::int(1).div(Q::ZERO),Err(Error::DivisionByZero));
        assert_eq!(Q(1).sqrt().unwrap().0, ((-8247+16383) as u128)<<112);
    }
    #[test] fn exact_direct_pair() {
        let p=Pair{displacement:[Q::ONE.0,0,0],sigma:Q::ONE.0,epsilon:Q::ONE.0,charge_product:0,prefactor:Q::ONE.0,switch_distance:Q::int(2).0,cutoff:Q::int(3).0,exception:true};
        assert_eq!(evaluate(p),Ok((0,[Q::int(-24).0,0,0])));
        assert_eq!(evaluate(Pair{displacement:[0;3],..p}),Err(Error::ZeroSeparation));
        assert_eq!(evaluate(Pair{displacement:[Q::int(3).0,0,0],exception:false,..p}),Ok((0,[0;3])));
    }
}
