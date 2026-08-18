import React, { useEffect, useState } from 'react';
import { database } from '../utils/supabase';

interface PhlebotomistSelectProps {
  value?: string;
  onChange: (userId: string, userName: string) => void;
  labId?: string;
  disabled?: boolean;
  className?: string;
  placeholder?: string;
}

interface Phlebotomist {
  id: string;
  name: string;
  email: string;
  role: string;
  phone?: string;
  contact_number?: string;
}

const PhlebotomistSelect: React.FC<PhlebotomistSelectProps> = ({
  value,
  onChange,
  labId,
  disabled = false,
  className = '',
  placeholder = 'Select phlebotomist...'
}) => {
  const [phlebotomists, setPhlebotomists] = useState<Phlebotomist[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetchPhlebotomists();
  }, [labId]);

  const fetchPhlebotomists = async () => {
    try {
      setLoading(true);
      setError(null);
      
      const { data, error: fetchError } = await database.users.getPhlebotomists(labId);
      
      if (fetchError) {
        throw fetchError;
      }
      
      setPhlebotomists(data || []);
    } catch (err) {
      console.error('Error fetching phlebotomists:', err);
      setError('Failed to load phlebotomists');
    } finally {
      setLoading(false);
    }
  };

  const handleChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const selectedId = e.target.value;
    const selectedPhlebotomist = phlebotomists.find(p => p.id === selectedId);
    
    if (selectedPhlebotomist) {
      onChange(selectedId, selectedPhlebotomist.name);
    }
  };

  if (loading) {
    return (
      <select 
        disabled 
        className={`${className} bg-gray-100 border border-gray-300 rounded px-3 py-2`}
      >
        <option>Loading phlebotomists...</option>
      </select>
    );
  }

  if (error) {
    return (
      <div className="text-red-600 text-sm">
        {error}
        <button 
          onClick={fetchPhlebotomists}
          className="ml-2 text-blue-600 underline"
        >
          Retry
        </button>
      </div>
    );
  }

  return (
    <select
      value={value || ''}
      onChange={handleChange}
      disabled={disabled}
      className={`${className} border border-gray-300 rounded px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500`}
    >
      <option value="">{placeholder}</option>
      {phlebotomists.map((phlebotomist) => (
        <option key={phlebotomist.id} value={phlebotomist.id}>
          {phlebotomist.name} {(phlebotomist.contact_number || phlebotomist.phone) ? `(${phlebotomist.contact_number || phlebotomist.phone})` : ''}
        </option>
      ))}
      {phlebotomists.length === 0 && (
        <option disabled>No phlebotomists available</option>
      )}
    </select>
  );
};

export default PhlebotomistSelect;
