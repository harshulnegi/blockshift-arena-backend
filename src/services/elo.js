export function ratingDelta(winnerRating, loserRating, k = 32) {
  const expectedWinner = 1 / (1 + 10 ** ((loserRating - winnerRating) / 400));
  const winnerDelta = Math.round(k * (1 - expectedWinner));
  return { winnerDelta, loserDelta: -winnerDelta };
}

export function tierForRating(rating) {
  if (rating >= 2400) return "Master";
  if (rating >= 2100) return "Diamond";
  if (rating >= 1800) return "Platinum";
  if (rating >= 1500) return "Gold";
  if (rating >= 1200) return "Silver";
  return "Bronze";
}
