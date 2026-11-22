package com.example.data

import androidx.room.Dao
import androidx.room.Insert
import androidx.room.OnConflictStrategy
import androidx.room.Query
import androidx.room.Transaction
import androidx.room.Update
import kotlinx.coroutines.flow.Flow

@Dao
interface OrderDao {
    @Query("SELECT * FROM orders ORDER BY createdAt DESC")
    fun getAllOrdersFlow(): Flow<List<OrderEntity>>

    @Query("SELECT * FROM orders WHERE firestoreDocId = :firestoreDocId LIMIT 1")
    suspend fun findByFirestoreDocId(firestoreDocId: String): OrderEntity?

    @Query("SELECT * FROM orders WHERE status IN ('ACCEPTED', 'AT_STORE', 'PICKED_UP', 'ORDER_DATA_ENTERED', 'AWAITING_MERCHANT_CONFIRMATION', 'MERCHANT_REJECTED', 'EN_ROUTE') ORDER BY createdAt DESC LIMIT 1")
    fun getActiveOrderFlow(): Flow<OrderEntity?>

    @Query("SELECT * FROM orders WHERE status = 'PENDING' ORDER BY createdAt DESC")
    fun getAvailablePendingOrdersFlow(): Flow<List<OrderEntity>>

    @Query("SELECT * FROM orders WHERE status = 'PENDING' ORDER BY createdAt DESC LIMIT 1")
    fun getPendingIncomingOrderFlow(): Flow<OrderEntity?>

    @Query("SELECT * FROM orders WHERE status = 'DELIVERED' ORDER BY createdAt DESC")
    fun getCompletedOrdersFlow(): Flow<List<OrderEntity>>

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun insertOrder(order: OrderEntity): Long

    @Transaction
    suspend fun upsertByFirestoreId(order: OrderEntity): Long {
        if (order.firestoreDocId.isNotBlank()) {
            val existing = findByFirestoreDocId(order.firestoreDocId)
            if (existing != null) {
                if (existing.status == OrderStatus.EXPIRED &&
                    order.status == OrderStatus.PENDING &&
                    (order.offerExpiresAt <= 0L || order.offerExpiresAt <= existing.offerExpiresAt)
                ) {
                    return existing.id
                }
                val mergedOrderCode = order.orderCode.ifBlank { existing.orderCode }
                val mergedOfferExpiresAt = if (order.offerExpiresAt > 0L) order.offerExpiresAt else existing.offerExpiresAt
                val mergedMerchantId = order.merchantId.ifBlank { existing.merchantId }
                val mergedStoreLocationUrl = order.storeLocationUrl.ifBlank { existing.storeLocationUrl }
                val incomingCoordsValid = order.restaurantLatitude != null &&
                    order.restaurantLongitude != null &&
                    order.restaurantLatitude.isFinite() &&
                    order.restaurantLongitude.isFinite() &&
                    !(order.restaurantLatitude == 0.0 && order.restaurantLongitude == 0.0)
                val mergedLat = if (incomingCoordsValid) order.restaurantLatitude else existing.restaurantLatitude
                val mergedLng = if (incomingCoordsValid) order.restaurantLongitude else existing.restaurantLongitude
                val mergedStorePhone = order.storePhone.ifBlank { existing.storePhone }
                val mergedStoreImage = order.storeImage.ifBlank { existing.storeImage }
                val mergedCaptainId = order.captainId.ifBlank { existing.captainId }
                val mergedReceiptImagePath = order.receiptImagePath.ifBlank { existing.receiptImagePath }
                val mergedOrderImageUrl = order.orderImageUrl.ifBlank { existing.orderImageUrl }
                val mergedReceiptUploadedAt = if (order.receiptUploadedAt > 0L) order.receiptUploadedAt else existing.receiptUploadedAt
                val mergedReceiptUploadedBy = order.receiptUploadedBy.ifBlank { existing.receiptUploadedBy }
                val mergedAcceptedAt = if (order.acceptedAt > 0L) order.acceptedAt else existing.acceptedAt
                val mergedCompletedAt = if (order.completedAt > 0L) order.completedAt else existing.completedAt
                val mergedCancelledAt = if (order.cancelledAt > 0L) order.cancelledAt else existing.cancelledAt
                val mergedCancellationReason = order.cancellationReason.ifBlank { existing.cancellationReason }

                return insertOrder(
                    order.copy(
                        id = existing.id,
                        orderCode = mergedOrderCode,
                        offerExpiresAt = mergedOfferExpiresAt,
                        merchantId = mergedMerchantId,
                        storeLocationUrl = mergedStoreLocationUrl,
                        restaurantLatitude = mergedLat,
                        restaurantLongitude = mergedLng,
                        storePhone = mergedStorePhone,
                        storeImage = mergedStoreImage,
                        captainId = mergedCaptainId,
                        receiptImagePath = mergedReceiptImagePath,
                        orderImageUrl = mergedOrderImageUrl,
                        receiptUploadedAt = mergedReceiptUploadedAt,
                        receiptUploadedBy = mergedReceiptUploadedBy,
                        acceptedAt = mergedAcceptedAt,
                        completedAt = mergedCompletedAt,
                        cancelledAt = mergedCancelledAt,
                        cancellationReason = mergedCancellationReason
                    )
                )
            }
        }
        return insertOrder(order)
    }

    @Update
    suspend fun updateOrder(order: OrderEntity)

    @Query("UPDATE orders SET status = :status WHERE id = :orderId")
    suspend fun updateOrderStatus(orderId: Long, status: OrderStatus)

    @Query("UPDATE orders SET status = :status, captainId = :captainId WHERE id = :orderId")
    suspend fun updateOrderStatusAndCaptain(orderId: Long, status: OrderStatus, captainId: String)

    @Query("UPDATE orders SET status = :status, cancelledAt = :cancelledAt, cancellationReason = :reason WHERE id = :orderId")
    suspend fun markOrderCancelled(
        orderId: Long,
        cancelledAt: Long,
        reason: String = "",
        status: OrderStatus = OrderStatus.CANCELLED
    )

    @Query("UPDATE orders SET orderImageUrl = :imageUrl, receiptImagePath = :imageUrl, status = :status WHERE id = :orderId")
    suspend fun updateOrderImageAndStatus(orderId: Long, imageUrl: String, status: OrderStatus)

    @Query(
        "UPDATE orders SET customerName = :customerName, customerPhone = :customerPhone, " +
            "orderImageUrl = :imageUrl, receiptImagePath = :receiptImagePath, " +
            "receiptUploadedAt = :receiptUploadedAt, receiptUploadedBy = :receiptUploadedBy, " +
            "notes = :notes, status = :status WHERE id = :orderId"
    )
    suspend fun updateCustomerDetails(
        orderId: Long,
        customerName: String,
        customerPhone: String,
        imageUrl: String,
        notes: String,
        status: OrderStatus,
        receiptImagePath: String = imageUrl,
        receiptUploadedAt: Long = System.currentTimeMillis(),
        receiptUploadedBy: String = ""
    )

    @Query("UPDATE orders SET merchantConfirmed = :confirmed, status = :status, rejectionReason = :reason WHERE id = :orderId")
    suspend fun updateMerchantConfirmation(orderId: Long, confirmed: Boolean, status: OrderStatus, reason: String)

    @Query("UPDATE orders SET status = :status, captainId = :captainId, acceptedAt = :acceptedAt WHERE id = :orderId")
    suspend fun markOrderAccepted(orderId: Long, captainId: String, acceptedAt: Long, status: OrderStatus = OrderStatus.ACCEPTED)

    @Query("UPDATE orders SET status = :status, captainId = :captainId, completedAt = :completedAt WHERE id = :orderId")
    suspend fun markOrderDelivered(orderId: Long, captainId: String, completedAt: Long, status: OrderStatus = OrderStatus.DELIVERED)

    @Query(
        "UPDATE orders SET storeLocationUrl = :locationUrl, " +
            "merchantId = CASE WHEN :merchantId != '' THEN :merchantId ELSE merchantId END, " +
            "restaurantLatitude = COALESCE(:lat, restaurantLatitude), " +
            "restaurantLongitude = COALESCE(:lng, restaurantLongitude) " +
            "WHERE id = :orderId"
    )
    suspend fun updateMerchantLocationInfo(
        orderId: Long,
        locationUrl: String,
        merchantId: String = "",
        lat: Double? = null,
        lng: Double? = null
    )

    @Query("DELETE FROM orders WHERE id = :orderId")
    suspend fun deleteOrderById(orderId: Long)

    @Query("DELETE FROM orders WHERE status = 'PENDING'")
    suspend fun deleteAllPendingOrders()

    @Query("DELETE FROM orders")
    suspend fun clearAll()

    @Query("SELECT COUNT(*) FROM orders WHERE status = 'DELIVERED'")
    fun getCompletedCountFlow(): Flow<Int>

    @Query("SELECT SUM(deliveryFee) FROM orders WHERE status = 'DELIVERED'")
    fun getTotalEarningsFlow(): Flow<Double?>
}
