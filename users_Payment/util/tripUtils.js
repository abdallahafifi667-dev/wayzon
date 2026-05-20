const { getOrderModel } = require("../models/order.models");

/**
 * Checks if two time ranges overlap.
 * @param {Date} start1
 * @param {number} duration1 (in hours)
 * @param {Date} start2
 * @param {number} duration2 (in hours)
 * @returns {boolean}
 */
function areTripsConflicting(start1, duration1, start2, duration2) {
  const s1 = new Date(start1).getTime();
  const e1 = s1 + duration1 * 60 * 60 * 1000;

  const s2 = new Date(start2).getTime();
  const e2 = s2 + duration2 * 60 * 60 * 1000;

  return s1 < e2 && s2 < e1;
}

/**
 * Automatically withdraws a guide from conflicting trips when they are confirmed for a trip.
 * @param {string} guideId
 * @param {Object} confirmedOrder - The trip the guide just got confirmed for
 */
async function withdrawConflicts(guideId, confirmedOrder) {
  const Order = getOrderModel();

  // Find all other orders where this guide is involved
  const otherOrders = await Order.find({
    _id: { $ne: confirmedOrder._id },
    $or: [
      { Interested: guideId },
      { "offers.guide": guideId, "offers.status": "pending" },
    ],
    status: { $in: ["open", "bidding"] },
  });

  for (const order of otherOrders) {
    if (
      areTripsConflicting(
        confirmedOrder.TripDate,
        confirmedOrder.duration,
        order.TripDate,
        order.duration,
      )
    ) {
      let modified = false;

      // Handle Interested array
      if (order.Interested.includes(guideId)) {
        order.Interested.pull(guideId);
        if (!order.WithdrawnInterested.includes(guideId)) {
          order.WithdrawnInterested.push(guideId);
        }
        modified = true;
      }

      // Handle offers array
      const offer = order.offers.find(
        (o) =>
          o.guide.toString() === guideId.toString() && o.status === "pending",
      );
      if (offer) {
        offer.status = "withdrawn_conflict";
        modified = true;
      }

      if (modified) await order.save();
    }
  }
}

/**
 * Restores a guide's interest/offers if they are no longer confirmed for a conflicting trip.
 * @param {string} guideId
 */
async function restoreConflicts(guideId) {
  const Order = getOrderModel();

  // 1. Get all currently confirmed trips for this guide
  const confirmedTrips = await Order.find({
    guide: guideId,
    status: "confirmed",
  });

  // 2. Find all orders where the guide was withdrawn due to conflict
  const withdrawnOrders = await Order.find({
    $or: [
      { WithdrawnInterested: guideId },
      { "offers.guide": guideId, "offers.status": "withdrawn_conflict" },
    ],
    status: { $in: ["open", "bidding"] },
  });

  for (const order of withdrawnOrders) {
    // Check if this order still conflicts with ANY of the remaining confirmed trips
    const stillConflicts = confirmedTrips.some((confirmed) =>
      areTripsConflicting(
        confirmed.TripDate,
        confirmed.duration,
        order.TripDate,
        order.duration,
      ),
    );

    if (!stillConflicts) {
      let modified = false;

      // Restore to Interested
      if (order.WithdrawnInterested.includes(guideId)) {
        order.WithdrawnInterested.pull(guideId);
        if (!order.Interested.includes(guideId)) {
          order.Interested.push(guideId);
        }
        modified = true;
      }

      // Restore offer
      const offer = order.offers.find(
        (o) =>
          o.guide.toString() === guideId.toString() &&
          o.status === "withdrawn_conflict",
      );
      if (offer) {
        offer.status = "pending";
        modified = true;
      }

      if (modified) await order.save();
    }
  }
}

module.exports = {
  areTripsConflicting,
  withdrawConflicts,
  restoreConflicts,
};
